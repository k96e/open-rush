/**
 * 请求方向：Anthropic Messages → OpenAI Chat Completions（M4·T4.7）。
 *
 * 映射是**封闭的**：只搬得动的字段才搬，其余一律丢弃（理由见 `types.ts`）。
 * 被丢掉的那些不是遗漏，是刻意的——它们送给 OpenAI 上游只会换来 400：
 *
 * | Anthropic 字段 | 处理 | 为什么 |
 * |---|---|---|
 * | `thinking` | 丢 | Claude Code 对不认识的模型名（网关 alias 就是）会发 `{"type":"adaptive"}`，OpenAI 上游不认 |
 * | `context_management` / `output_config` / `mcp_servers` / `container` | 丢 | Anthropic 专有 body 字段，上游报 `Extra inputs are not permitted` |
 * | `cache_control` 标记 | 丢 | OpenAI 侧没有对应概念；留着会变成非法的 content part |
 * | `top_k` | 丢 | OpenAI Chat Completions 没有这个参数 |
 * | `thinking` / `redacted_thinking` 内容块 | 丢 | 上一轮的思考过程无法在 OpenAI 消息里表达 |
 * | `document` 内容块 | 丢 | Chat Completions 没有文档块 |
 *
 * ⚠️ **系统提示归属块**：Claude Code 会在 `system` 数组首位放一段归属块，
 * `api.anthropic.com` 会按位置把它剥掉。翻译必然要重排 `system`，剥离逻辑因此
 * 失效，那段文本会进入上游的提示词与缓存键。走 translate 的部署应当让开发者设
 * `CLAUDE_CODE_ATTRIBUTION_HEADER=0`（见 `docs/plans/llm-router/ref/R9`）。
 */
import { ProtocolTranslateError, type TranslateRequestOptions } from './types.js';

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Obj[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/** `system`（string 或内容块数组）→ 一条 system 消息的纯文本。空则不产生消息。 */
export function flattenSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  const parts: string[] = [];
  for (const block of system) {
    if (isObj(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/** Anthropic 图片块 → OpenAI `image_url` 的 URL。认不出来返回 null（丢弃该块）。 */
function imageUrlOf(block: Obj): string | null {
  const source = block.source;
  if (!isObj(source)) return null;
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  if (
    source.type === 'base64' &&
    typeof source.data === 'string' &&
    typeof source.media_type === 'string'
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

/**
 * `tool_result.content` → OpenAI tool 消息的文本。
 *
 * Anthropic 允许 tool_result 里带图片，OpenAI 的 `role: 'tool'` 消息**只收文本**，
 * 因此图片块在这里被丢掉——这是本适配器最实质的一处有损翻译，已记在验收报告里。
 */
export function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isObj(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** 用户消息：tool_result 先出（OpenAI 要求 tool 消息紧跟在触发它的 assistant 之后）。 */
function translateUserMessage(content: unknown, out: OpenAiMessage[]): void {
  if (typeof content === 'string') {
    if (content) out.push({ role: 'user', content });
    return;
  }
  if (!Array.isArray(content)) return;

  const toolMessages: OpenAiMessage[] = [];
  const parts: Obj[] = [];
  let hasImage = false;

  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      toolMessages.push({
        role: 'tool',
        tool_call_id: id,
        content: flattenToolResult(block.content),
      });
    } else if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const url = imageUrlOf(block);
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
        hasImage = true;
      }
    }
    // 其余块（document / thinking / tool_reference / …）刻意丢弃。
  }

  // tool 消息必须排在同一轮的普通用户内容之前，否则上游看到的是
  // 「assistant 发起工具调用 → 用户说话 → 工具结果」这种非法顺序。
  out.push(...toolMessages);

  if (parts.length === 0) return;
  // 纯文本时降级成字符串：不少 OpenAI 兼容实现只认字符串形式的 content。
  out.push({
    role: 'user',
    content: hasImage
      ? parts
      : parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(''),
  });
}

function translateAssistantMessage(content: unknown, out: OpenAiMessage[]): void {
  if (typeof content === 'string') {
    if (content) out.push({ role: 'assistant', content });
    return;
  }
  if (!Array.isArray(content)) return;

  const texts: string[] = [];
  const toolCalls: OpenAiToolCall[] = [];

  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : '',
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking / redacted_thinking 刻意丢弃：OpenAI 消息里没有它们的位置。
  }

  if (texts.length === 0 && toolCalls.length === 0) return;
  const msg: OpenAiMessage = {
    role: 'assistant',
    // 带 tool_calls 时 content 允许为 null，这是 OpenAI 的规定形状。
    content: texts.length > 0 ? texts.join('') : null,
  };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  out.push(msg);
}

/** `tools[]` → OpenAI function 工具。没有 `input_schema` 的（Anthropic 托管工具）丢弃。 */
export function translateTools(tools: unknown): Obj[] | null {
  if (!Array.isArray(tools)) return null;
  const out: Obj[] = [];
  for (const tool of tools) {
    if (!isObj(tool)) continue;
    const name = tool.name;
    const schema = tool.input_schema;
    if (typeof name !== 'string' || !isObj(schema)) continue;
    const fn: Obj = { name, parameters: schema };
    if (typeof tool.description === 'string') fn.description = tool.description;
    out.push({ type: 'function', function: fn });
  }
  return out.length > 0 ? out : null;
}

/** `tool_choice` 四种取值的映射。认不出来返回 undefined（不带这个字段）。 */
export function translateToolChoice(choice: unknown): unknown {
  if (!isObj(choice)) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return typeof choice.name === 'string'
        ? { type: 'function', function: { name: choice.name } }
        : undefined;
    default:
      return undefined;
  }
}

export function translateAnthropicRequest(
  body: Uint8Array,
  opts: TranslateRequestOptions
): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(body));
  } catch {
    // 刻意不带上 V8 的解析错误原文——它会把调用方 body 的片段抄进 400 响应里。
    // 同协议路径上的 `rewriteModelField` 走的也是固定文案，两边保持一致。
    throw new ProtocolTranslateError('request body is not valid JSON');
  }
  if (!isObj(parsed)) throw new ProtocolTranslateError('request body must be a JSON object');
  if (!Array.isArray(parsed.messages)) {
    throw new ProtocolTranslateError("field 'messages' must be an array");
  }

  const messages: OpenAiMessage[] = [];
  const system = flattenSystem(parsed.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const raw of parsed.messages) {
    if (!isObj(raw)) continue;
    if (raw.role === 'assistant') translateAssistantMessage(raw.content, messages);
    else translateUserMessage(raw.content, messages);
  }

  const out: Obj = { model: opts.upstreamModel, messages };

  if (typeof parsed.max_tokens === 'number') out.max_tokens = parsed.max_tokens;
  if (typeof parsed.temperature === 'number') out.temperature = parsed.temperature;
  if (typeof parsed.top_p === 'number') out.top_p = parsed.top_p;
  if (Array.isArray(parsed.stop_sequences) && parsed.stop_sequences.length > 0) {
    out.stop = parsed.stop_sequences;
  }
  if (isObj(parsed.metadata) && typeof parsed.metadata.user_id === 'string') {
    out.user = parsed.metadata.user_id;
  }

  const tools = translateTools(parsed.tools);
  if (tools) {
    out.tools = tools;
    const choice = translateToolChoice(parsed.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }

  if (opts.stream) {
    out.stream = true;
    // 不开这个开关，OpenAI 流式一个 usage 都不回，A5 的明细计量直接落空。
    out.stream_options = { include_usage: true };
  }

  return ENCODER.encode(JSON.stringify(out));
}
