/**
 * 响应方向的翻译（M4·T4.7）：非流式对象映射 + 流式事件序列。
 *
 * 流式这半边是本任务风险最高的地方——Anthropic 的块一旦 `content_block_stop`
 * 就回不去了，而 OpenAI 允许多工具调用交错。所以这里既测顺序，也测交错。
 */
import { describe, expect, it } from 'vitest';
import {
  mapFinishReason,
  OpenAiToAnthropicStreamTranslator,
  translateOpenAiCompletion,
  translateUsage,
} from '../openai-to-anthropic.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function completion(body: unknown): Record<string, unknown> | null {
  const out = translateOpenAiCompletion(ENCODER.encode(JSON.stringify(body)), 'fallback-model');
  return out === null ? null : (JSON.parse(DECODER.decode(out)) as Record<string, unknown>);
}

/** 把一串 SSE 文本解析成 `{ event, data }` 序列——断言事件序列比断言字符串可读得多。 */
function parseEvents(sse: string): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const frame of sse.split('\n\n')) {
    if (!frame.trim()) continue;
    const lines = frame.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? '';
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '{}';
    out.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return out;
}

function runStream(chunks: string[], fallbackModel = 'gpt-4o'): ReturnType<typeof parseEvents> {
  const t = new OpenAiToAnthropicStreamTranslator({ fallbackModel });
  let sse = '';
  for (const chunk of chunks) sse += t.push(ENCODER.encode(chunk));
  sse += t.end();
  return parseEvents(sse);
}

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

// ───────────────────────────── 非流式 ─────────────────────────────

describe('translateOpenAiCompletion', () => {
  it('文本响应 → Anthropic message', () => {
    const out = completion({
      id: 'chatcmpl-1',
      model: 'gpt-4o-2024',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    expect(out).toEqual({
      id: 'chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-4o-2024',
      content: [{ type: 'text', text: 'hi there' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 4,
      },
    });
  });

  it('tool_calls → tool_use 块，参数字符串被解析成对象', () => {
    const out = completion({
      id: 'c1',
      model: 'm',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(out?.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
    ]);
    expect(out?.stop_reason).toBe('tool_use');
  });

  it('★ 上游回了 tool_calls 但 finish_reason=stop 时仍判 tool_use', () => {
    const out = completion({
      id: 'c1',
      model: 'm',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }],
          },
          finish_reason: 'stop',
        },
      ],
    });
    expect(out?.stop_reason).toBe('tool_use');
  });

  it('工具参数不是合法 JSON 时退化成空对象，而不是整条响应作废', () => {
    const out = completion({
      id: 'c1',
      model: 'm',
      choices: [
        {
          message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"hal' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(out?.content).toEqual([{ type: 'tool_use', id: 'c', name: 'f', input: {} }]);
  });

  it('reasoning_content → thinking 块，排在正文之前', () => {
    const out = completion({
      id: 'c1',
      model: 'm',
      choices: [{ message: { reasoning_content: 'let me think', content: 'answer' } }],
    });
    expect(out?.content).toEqual([
      { type: 'thinking', thinking: 'let me think' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('缓存命中从 input_tokens 里减掉（与计量侧同口径）', () => {
    const out = completion({
      id: 'c1',
      model: 'm',
      choices: [{ message: { content: 'x' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 900 },
      },
    });
    expect(out?.usage).toEqual({
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 900,
      output_tokens: 5,
    });
  });

  it('上游没给 model 时用目录里的 upstream_model 兜底，没给 id 时造一个 msg_', () => {
    const out = completion({ choices: [{ message: { content: 'x' } }] });
    expect(out?.model).toBe('fallback-model');
    expect(String(out?.id)).toMatch(/^msg_[0-9a-f]{32}$/);
  });

  it('★ 翻不动时返回 null（非 JSON / 没有 choices），交给调用方回 502', () => {
    expect(translateOpenAiCompletion(ENCODER.encode('<html>502</html>'), 'm')).toBeNull();
    expect(completion({ error: { message: 'boom' } })).toBeNull();
  });
});

describe('mapFinishReason / translateUsage', () => {
  it('五条映射 + 未知值兜底 end_turn', () => {
    expect(mapFinishReason('stop', false)).toBe('end_turn');
    expect(mapFinishReason('length', false)).toBe('max_tokens');
    expect(mapFinishReason('tool_calls', false)).toBe('tool_use');
    expect(mapFinishReason('function_call', false)).toBe('tool_use');
    expect(mapFinishReason('content_filter', false)).toBe('refusal');
    expect(mapFinishReason('who_knows', false)).toBe('end_turn');
    expect(mapFinishReason(null, false)).toBe('end_turn');
  });

  it('length 不会被 sawToolUse 改写（真的是被截断了）', () => {
    expect(mapFinishReason('length', true)).toBe('max_tokens');
  });

  it('usage 缺字段 / 非对象一律出 0，不抛', () => {
    expect(translateUsage(undefined)).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });
    expect(translateUsage({ prompt_tokens: 'x', completion_tokens: 3 }).output_tokens).toBe(3);
  });
});

// ───────────────────────────── 流式 ─────────────────────────────

describe('OpenAiToAnthropicStreamTranslator · 事件序列', () => {
  it('★ 纯文本流的完整事件序列', () => {
    const events = runStream([
      data({ id: 'chatcmpl-9', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' } }] }),
      data({ choices: [{ delta: { content: 'Hel' } }] }),
      data({ choices: [{ delta: { content: 'lo' } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ]);

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = events[0].data.message as Record<string, unknown>;
    expect(start).toMatchObject({
      id: 'chatcmpl-9',
      model: 'gpt-4o',
      role: 'assistant',
      content: [],
    });
    // 开头拿不到 usage：OpenAI 到最后一个 chunk 才给。
    expect(start.usage).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });

    expect(events[2].data.delta).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(events[5].data).toMatchObject({
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 7, output_tokens: 2 },
    });
  });

  it('文本拼起来与上游逐字相同（不丢不改序）', () => {
    const pieces = ['Once ', 'upon ', 'a ', 'time'];
    const events = runStream(pieces.map((p) => data({ choices: [{ delta: { content: p } }] })));
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data.delta as Record<string, string>).text)
      .join('');
    expect(text).toBe('Once upon a time');
  });

  it('★ 工具调用：攒齐后按 index 升序整块发出', () => {
    const events = runStream([
      data({ id: 'c1', model: 'm', choices: [{ delta: { content: 'calling' } }] }),
      data({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '{"ci' } },
              ],
            },
          },
        ],
      }),
      data({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] } }],
      }),
      data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start', // text
      'content_block_delta',
      'content_block_stop', // text 块在工具块之前关掉
      'content_block_start', // tool_use
      'content_block_delta', // input_json_delta
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[4].data).toMatchObject({
      index: 1,
      content_block: { type: 'tool_use', id: 'call_a', name: 'get_weather', input: {} },
    });
    expect(events[5].data.delta).toEqual({
      type: 'input_json_delta',
      partial_json: '{"city":"SF"}',
    });
    expect(events[7].data).toMatchObject({ delta: { stop_reason: 'tool_use' } });
  });

  it('★ 多个工具调用交错到达也不丢参数（逐片直发的写法会在这里挂）', () => {
    const events = runStream([
      data({
        id: 'c',
        model: 'm',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'a', function: { name: 'f0', arguments: '{"x' } }],
            },
          },
        ],
      }),
      data({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, id: 'b', function: { name: 'f1', arguments: '{"y' } }],
            },
          },
        ],
      }),
      data({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }],
      }),
      data({
        choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '":2}' } }] } }],
      }),
      data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    const starts = events.filter((e) => e.event === 'content_block_start');
    expect(starts.map((e) => (e.data.content_block as Record<string, unknown>).name)).toEqual([
      'f0',
      'f1',
    ]);
    const deltas = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data.delta as Record<string, string>).partial_json);
    expect(deltas).toEqual(['{"x":1}', '{"y":2}']);
    // 块索引严格递增且成对开合
    expect(starts.map((e) => e.data.index)).toEqual([0, 1]);
  });

  it('reasoning_content → thinking 块，正文另开一个块', () => {
    const events = runStream([
      data({ id: 'c', model: 'm', choices: [{ delta: { reasoning_content: 'думаю' } }] }),
      data({ choices: [{ delta: { reasoning_content: '...' } }] }),
      data({ choices: [{ delta: { content: 'answer' } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[1].data.content_block).toEqual({ type: 'thinking', thinking: '', signature: '' });
    expect(events[2].data.delta).toEqual({ type: 'thinking_delta', thinking: 'думаю' });
    expect(events[5].data.content_block).toEqual({ type: 'text', text: '' });
  });

  it('跨 chunk 的多字节 UTF-8 不被截断', () => {
    const payload = ENCODER.encode(
      data({ id: 'c', model: 'm', choices: [{ delta: { content: '中文测试' } }] })
    );
    const t = new OpenAiToAnthropicStreamTranslator({ fallbackModel: 'm' });
    let sse = '';
    // 逐字节喂：每个多字节字符都会跨 chunk。
    for (const byte of payload) sse += t.push(new Uint8Array([byte]));
    sse += t.end();
    const events = parseEvents(sse);
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data.delta as Record<string, string>).text)
      .join('');
    expect(text).toBe('中文测试');
  });

  it('畸形 JSON / 注释行 / event: 行 / [DONE] 都不影响解析', () => {
    const events = runStream([
      ': keep-alive comment\n\n',
      'event: chunk\ndata: {"id":"c","model":"m","choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"broken":\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(events.filter((e) => e.event === 'content_block_delta')).toHaveLength(1);
    expect(events.at(-1)?.event).toBe('message_stop');
  });

  it('上游一个 chunk 都没回时也发出完整的空消息（客户端不会永远等）', () => {
    const events = runStream([]);
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect((events[0].data.message as Record<string, unknown>).model).toBe('gpt-4o');
    expect(events[1].data).toMatchObject({ delta: { stop_reason: 'end_turn' } });
  });

  it('end() 幂等：重复调用返回空串', () => {
    const t = new OpenAiToAnthropicStreamTranslator({ fallbackModel: 'm' });
    expect(t.end()).not.toBe('');
    expect(t.end()).toBe('');
    expect(t.push(ENCODER.encode(data({ choices: [{ delta: { content: 'x' } }] })))).toBe('');
  });

  it('★ 自审补：攒出来的工具参数不是合法 JSON 对象时不发 input_json_delta', () => {
    const events = runStream([
      data({
        id: 'c',
        model: 'm',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{"x' } }],
            },
          },
        ],
      }),
      // 上游在这里断了：参数只有半截。
      data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    // 块照开（调用方知道模型想调这个工具），但不发一段解析不了的 partial_json。
    const start = events.find((e) => e.event === 'content_block_start');
    expect(start?.data.content_block).toEqual({ type: 'tool_use', id: 'a', name: 'f', input: {} });
    expect(events.some((e) => e.event === 'content_block_delta')).toBe(false);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('自审补：与非流式同口径——非流式那条同样退化成 input: {}', () => {
    const out = completion({
      id: 'c',
      model: 'm',
      choices: [
        { message: { tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{"x' } }] } },
      ],
    });
    expect(out?.content).toEqual([{ type: 'tool_use', id: 'a', name: 'f', input: {} }]);
  });

  it('refusal 走正文块，stop_reason 记 refusal', () => {
    const events = runStream([
      data({ id: 'c', model: 'm', choices: [{ delta: { refusal: 'I cannot help' } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
    ]);
    expect(events[2].data.delta).toEqual({ type: 'text_delta', text: 'I cannot help' });
    expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: 'refusal' } });
  });
});
