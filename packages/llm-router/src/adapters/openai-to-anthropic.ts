/**
 * 响应方向：OpenAI Chat Completions → Anthropic Messages（M4·T4.7）。
 *
 * 两条路径：
 *  - 非流式：`translateOpenAiCompletion()`，一次性对象映射；
 *  - 流式：{@link OpenAiToAnthropicStreamTranslator}，把 OpenAI 的 chunk 序列
 *    重放成 Anthropic 的 `message_start → content_block_* → message_delta →
 *    message_stop` 事件序列。
 *
 * ## 工具调用为什么攒到最后才发
 *
 * OpenAI 的 `delta.tool_calls[]` 带自己的 `index`，多工具并行时**允许交错**；
 * Anthropic 的流一次只能开一个 content block，块一旦 `content_block_stop` 就
 * 再也回不去。逐片直发的写法在交错上游上会静默丢参数（LiteLLM 与多个开源代理
 * 都踩过这个坑）。所以这里按 OpenAI index 攒齐，在 `end()` 时按 index 升序整块
 * 发出。代价只是工具参数不再逐字流出——而 Claude Code 本来也要等 `message_stop`
 * 之后才执行工具，且经网关时「细粒度工具流式」默认就是关的，功能上零损失。
 *
 * ## 已知的有损之处（验收报告必须如实写明）
 *  - `message_start.usage` 全 0：OpenAI 到最后一个 chunk 才给 usage，开头无从得知；
 *    真实用量在 `message_delta.usage` 里给全。
 *  - `stop_sequence` 恒为 null：OpenAI 不告诉我们命中的是哪一条停止串。
 *  - 思考内容（`reasoning_content` / `reasoning`）翻成 `thinking` 块，但**没有
 *    signature**——它本来就不是 Anthropic 签的，不能伪造一个。
 */
import { randomUUID } from 'node:crypto';
import { parseJsonObject, SseLineReader } from '../usage/sse-line-reader.js';
import { sseEvent } from './sse.js';

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** `finish_reason` → `stop_reason`。表里没有的一律 `end_turn`。 */
export const FINISH_REASON_MAP: Readonly<Record<string, string>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

/**
 * 映射停止原因。
 *
 * `sawToolUse` 这个修正项是必要的：不少 OpenAI 兼容实现在回了 `tool_calls` 之后
 * 仍然把 `finish_reason` 写成 `stop`。照抄过去会让 Anthropic 侧的调用方以为这轮
 * 是普通结束，从而根本不去执行工具。
 */
export function mapFinishReason(reason: unknown, sawToolUse: boolean): string {
  const key = typeof reason === 'string' ? reason : '';
  const mapped = FINISH_REASON_MAP[key] ?? 'end_turn';
  return sawToolUse && mapped === 'end_turn' ? 'tool_use' : mapped;
}

export interface AnthropicUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

/**
 * OpenAI `usage` → Anthropic `usage`。
 *
 * `prompt_tokens` **含**缓存命中，Anthropic 的 `input_tokens` 不含，所以要减掉
 * ——这与 `usage/openai-parser.ts` 的口径完全一致（同一份账不能有两种算法）。
 */
export function translateUsage(raw: unknown): AnthropicUsage {
  if (!isObj(raw)) {
    return {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    };
  }
  const details = isObj(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const cached = num(details?.cached_tokens);
  return {
    input_tokens: Math.max(0, num(raw.prompt_tokens) - cached),
    // OpenAI 面没有「缓存写入」这一维度，恒 0（与计量侧同口径）。
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: num(raw.completion_tokens),
  };
}

/** 兜底的消息 id：上游没给时才用，正常路径原样沿用上游 id 以便两侧日志对齐。 */
function fallbackMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, '')}`;
}

/**
 * 工具参数的 JSON 校验。
 *
 * 上游可能给半截或非法的 `arguments`（流被截断、实现有 bug）。两条路径必须同口径：
 * 非流式退化成 `{}`，流式就**不发 `input_json_delta`**（块里的 `input` 保持 `{}`）。
 * 发一段解析不了的 `partial_json` 更糟——调用方会在工具分发处拿到语法错误，
 * 而不是「模型想调这个工具但参数没给全」。
 */
function parseToolArguments(args: string): Obj | null {
  if (!args) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolUseBlock(id: string, name: string, args: string): Obj {
  return { type: 'tool_use', id, name, input: parseToolArguments(args) ?? {} };
}

// ─────────────────────────── 非流式 ───────────────────────────

/**
 * 把一份 OpenAI Chat Completion 响应体翻成 Anthropic Message。
 *
 * **翻不动返回 null**（body 不是 JSON 对象 / 没有 choices）——调用方据此回 502，
 * 而不是把上游形状的东西冒充成 Anthropic 响应。
 */
export function translateOpenAiCompletion(
  raw: Uint8Array,
  fallbackModel: string
): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(raw));
  } catch {
    return null;
  }
  if (!isObj(parsed) || !Array.isArray(parsed.choices)) return null;

  const choice = isObj(parsed.choices[0]) ? (parsed.choices[0] as Obj) : {};
  const message = isObj(choice.message) ? choice.message : {};
  const content: Obj[] = [];

  const reasoning = str(message.reasoning_content) ?? str(message.reasoning);
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });

  const text = str(message.content) ?? str(message.refusal);
  if (text) content.push({ type: 'text', text });

  let sawToolUse = false;
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isObj(call)) continue;
      const fn = isObj(call.function) ? call.function : {};
      sawToolUse = true;
      content.push(
        toolUseBlock(
          str(call.id) ?? `toolu_${randomUUID().replace(/-/g, '')}`,
          str(fn.name) ?? '',
          typeof fn.arguments === 'string' ? fn.arguments : ''
        )
      );
    }
  }

  const body = {
    id: str(parsed.id) ?? fallbackMessageId(),
    type: 'message',
    role: 'assistant',
    model: str(parsed.model) ?? fallbackModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason, sawToolUse),
    // OpenAI 不回传命中的停止串，只说 finish_reason=stop。
    stop_sequence: null,
    usage: translateUsage(parsed.usage),
  };
  return ENCODER.encode(JSON.stringify(body));
}

// ─────────────────────────── 流式 ───────────────────────────

type BlockKind = 'text' | 'thinking';

interface PendingToolCall {
  id: string | null;
  name: string | null;
  args: string;
}

export interface StreamTranslatorOptions {
  /** 上游没在 chunk 里回 `model` 时用的兜底值（目录里的 `upstream_model`）。 */
  fallbackModel: string;
}

/**
 * OpenAI SSE chunk → Anthropic SSE 事件序列的状态机。
 *
 * 纯函数式接口：`push()` 吃上游字节、吐要发给调用方的 SSE 文本；`end()` 收尾。
 * 不碰流、不碰定时器——那两件事在 `translate-stream.ts` 里，这样状态机本身可以
 * 用纯字符串断言测试。
 */
export class OpenAiToAnthropicStreamTranslator {
  private readonly lines = new SseLineReader();
  private readonly fallbackModel: string;
  private readonly toolCalls = new Map<number, PendingToolCall>();

  private started = false;
  private stopped = false;
  private nextIndex = 0;
  private open: { index: number; kind: BlockKind } | null = null;
  private messageId: string | null = null;
  private model: string | null = null;
  private finishReason: unknown = null;
  private usage: unknown = null;

  constructor(opts: StreamTranslatorOptions) {
    this.fallbackModel = opts.fallbackModel;
  }

  /** 吃一个上游 chunk，返回要写给调用方的 SSE 文本（可能是空串）。 */
  push(chunk: Uint8Array): string {
    if (this.stopped) return '';
    let out = '';
    for (const payload of this.lines.push(chunk)) {
      const evt = parseJsonObject(payload);
      if (evt) out += this.absorb(evt);
    }
    return out;
  }

  /** 收尾。**幂等**：重复调用返回空串。 */
  end(): string {
    if (this.stopped) return '';
    this.stopped = true;
    let out = '';
    if (!this.started) out += this.startMessage(null, null);
    out += this.closeOpenBlock();
    out += this.flushToolCalls();
    out += this.messageDelta();
    out += sseEvent('message_stop', { type: 'message_stop' });
    return out;
  }

  private absorb(evt: Obj): string {
    let out = '';
    if (!this.started) out += this.startMessage(str(evt.id), str(evt.model));
    if (evt.usage !== undefined && evt.usage !== null) this.usage = evt.usage;

    const choices = evt.choices;
    if (!Array.isArray(choices) || choices.length === 0) return out;
    const choice = choices[0];
    if (!isObj(choice)) return out;

    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;

    const delta = isObj(choice.delta) ? choice.delta : null;
    if (!delta) return out;

    // 思考在前、正文在后——与 Anthropic 自己的块顺序一致。
    const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
    if (reasoning) {
      out += this.ensureBlock('thinking');
      out += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: this.open?.index ?? 0,
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }

    const text = textOfDelta(delta);
    if (text) {
      out += this.ensureBlock('text');
      out += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: this.open?.index ?? 0,
        delta: { type: 'text_delta', text },
      });
    }

    if (Array.isArray(delta.tool_calls)) this.absorbToolCalls(delta.tool_calls);
    return out;
  }

  /** 只累积，不发事件——发送统一在 `end()`（见文件头「为什么攒到最后」）。 */
  private absorbToolCalls(calls: unknown[]): void {
    for (const call of calls) {
      if (!isObj(call)) continue;
      const index = typeof call.index === 'number' ? call.index : this.toolCalls.size;
      const pending = this.toolCalls.get(index) ?? { id: null, name: null, args: '' };
      const id = str(call.id);
      if (id) pending.id = id;
      const fn = isObj(call.function) ? call.function : null;
      const name = str(fn?.name);
      if (name) pending.name = name;
      if (fn && typeof fn.arguments === 'string') pending.args += fn.arguments;
      this.toolCalls.set(index, pending);
    }
  }

  private startMessage(id: string | null, model: string | null): string {
    this.started = true;
    this.messageId = id ?? this.messageId ?? fallbackMessageId();
    this.model = model ?? this.model ?? this.fallbackModel;
    return sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // OpenAI 到最后一个 chunk 才给 usage，开头只能是 0。真实值在 message_delta。
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
  }

  private ensureBlock(kind: BlockKind): string {
    if (this.open?.kind === kind) return '';
    let out = this.closeOpenBlock();
    const index = this.nextIndex++;
    this.open = { index, kind };
    out += sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block:
        kind === 'text'
          ? { type: 'text', text: '' }
          : // signature 留空：这段思考不是 Anthropic 签的，不能伪造一个。
            { type: 'thinking', thinking: '', signature: '' },
    });
    return out;
  }

  private closeOpenBlock(): string {
    if (!this.open) return '';
    const { index } = this.open;
    this.open = null;
    return sseEvent('content_block_stop', { type: 'content_block_stop', index });
  }

  private flushToolCalls(): string {
    if (this.toolCalls.size === 0) return '';
    let out = '';
    for (const key of [...this.toolCalls.keys()].sort((a, b) => a - b)) {
      const pending = this.toolCalls.get(key);
      if (!pending) continue;
      const index = this.nextIndex++;
      out += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: pending.id ?? `toolu_${randomUUID().replace(/-/g, '')}`,
          name: pending.name ?? '',
          input: {},
        },
      });
      // 只有攒出来的参数确实是个合法 JSON 对象时才发——见 `parseToolArguments`。
      if (parseToolArguments(pending.args)) {
        out += sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: pending.args },
        });
      }
      out += sseEvent('content_block_stop', { type: 'content_block_stop', index });
    }
    return out;
  }

  private messageDelta(): string {
    return sseEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReason(this.finishReason, this.toolCalls.size > 0),
        stop_sequence: null,
      },
      usage: translateUsage(this.usage),
    });
  }
}

/** `delta.content` 允许是字符串，也可能是内容块数组（部分兼容实现如此）。 */
function textOfDelta(delta: Obj): string {
  const content = delta.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let text = '';
    for (const part of content) {
      if (isObj(part) && typeof part.text === 'string') text += part.text;
    }
    if (text) return text;
  }
  // 拒答文本没有对应的 Anthropic 内容块类型，按正文发出去，配合 stop_reason=refusal。
  return str(delta.refusal) ?? '';
}
