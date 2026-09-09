/**
 * 请求方向的翻译（M4·T4.7，A1 第三档）。
 *
 * 这一档**不承诺字节一致**，所以测试断言的是「语义等价」：该搬的搬到位、
 * 该丢的确实丢掉（丢错了会让 OpenAI 上游直接 400）、顺序不能乱。
 */
import { describe, expect, it } from 'vitest';
import {
  flattenSystem,
  flattenToolResult,
  translateAnthropicRequest,
  translateToolChoice,
  translateTools,
} from '../anthropic-to-openai.js';
import { ProtocolTranslateError } from '../types.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function translate(body: unknown, stream = false): Record<string, unknown> {
  const out = translateAnthropicRequest(ENCODER.encode(JSON.stringify(body)), {
    upstreamModel: 'gpt-4o-mini',
    stream,
  });
  return JSON.parse(DECODER.decode(out)) as Record<string, unknown>;
}

describe('translateAnthropicRequest · 基本形状', () => {
  it('model 换成上游模型名，messages 原样搬', () => {
    const out = translate({
      model: 'my-alias',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(out.max_tokens).toBe(1024);
  });

  it('system 字符串 → 首条 system 消息', () => {
    const out = translate({
      model: 'a',
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('system 内容块数组 → 用空行拼成一条 system 消息', () => {
    const out = translate({
      model: 'a',
      system: [
        { type: 'text', text: 'block one' },
        { type: 'text', text: 'block two' },
      ],
      messages: [],
    });
    expect(out.messages).toEqual([{ role: 'system', content: 'block one\n\nblock two' }]);
  });

  it('采样参数按名映射，top_k 丢掉（OpenAI 没有这个参数）', () => {
    const out = translate({
      model: 'a',
      messages: [],
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['STOP'],
      metadata: { user_id: 'u-1' },
    });
    expect(out).toMatchObject({ temperature: 0.3, top_p: 0.9, stop: ['STOP'], user: 'u-1' });
    expect(out).not.toHaveProperty('top_k');
  });

  it('★ Anthropic 专有字段全部丢弃（留着就是上游 400）', () => {
    const out = translate({
      model: 'a',
      messages: [],
      thinking: { type: 'adaptive' },
      context_management: { edits: [] },
      output_config: { effort: 'high' },
      mcp_servers: [{ name: 'x' }],
      container: 'c-1',
      anthropic_version: '2023-06-01',
    });
    for (const key of [
      'thinking',
      'context_management',
      'output_config',
      'mcp_servers',
      'container',
      'anthropic_version',
    ]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('流式时打开 stream_options.include_usage（不开就没有 usage）', () => {
    const out = translate({ model: 'a', messages: [] }, true);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it('非流式不带 stream 字段', () => {
    const out = translate({ model: 'a', messages: [] }, false);
    expect(out).not.toHaveProperty('stream');
    expect(out).not.toHaveProperty('stream_options');
  });
});

describe('translateAnthropicRequest · 内容块', () => {
  it('assistant 的 tool_use → tool_calls，参数序列化成字符串', () => {
    const out = translate({
      model: 'a',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SF"}' },
          },
        ],
      },
    ]);
  });

  it('只有 tool_use 时 content 是 null（OpenAI 规定的形状）', () => {
    const out = translate({
      model: 'a',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      ],
    });
    expect((out.messages as Record<string, unknown>[])[0].content).toBeNull();
  });

  it('★ user 里的 tool_result → 独立的 tool 消息，且排在同轮普通内容之前', () => {
    const out = translate({
      model: 'a',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' },
            { type: 'text', text: 'and then?' },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'tool', tool_call_id: 'toolu_1', content: 'sunny' },
      { role: 'user', content: 'and then?' },
    ]);
  });

  it('图片块 → image_url（base64 转 data URI），此时 content 才用数组形式', () => {
    const out = translate({
      model: 'a',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    });
    expect((out.messages as Record<string, unknown>[])[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('纯文本块降级成字符串（不少兼容实现只认字符串）', () => {
    const out = translate({
      model: 'a',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
    });
    expect((out.messages as Record<string, unknown>[])[0].content).toBe('plain');
  });

  it('thinking / document / 未知块被丢弃，不产生空消息', () => {
    const out = translate({
      model: 'a',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'redacted_thinking', data: 'xx' },
          ],
        },
        { role: 'user', content: [{ type: 'document', source: {} }] },
      ],
    });
    expect(out.messages).toEqual([]);
  });
});

describe('translateTools / translateToolChoice', () => {
  it('input_schema → parameters；没有 schema 的托管工具被丢掉', () => {
    expect(
      translateTools([
        { name: 'get_weather', description: 'w', input_schema: { type: 'object' } },
        { type: 'web_search_20250305', name: 'web_search' },
      ])
    ).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object' }, description: 'w' },
      },
    ]);
  });

  it('一个都不剩时返回 null（不发空 tools 数组）', () => {
    expect(translateTools([{ type: 'web_search_20250305' }])).toBeNull();
    expect(translateTools(undefined)).toBeNull();
  });

  it('tool_choice 四种取值', () => {
    expect(translateToolChoice({ type: 'auto' })).toBe('auto');
    expect(translateToolChoice({ type: 'any' })).toBe('required');
    expect(translateToolChoice({ type: 'none' })).toBe('none');
    expect(translateToolChoice({ type: 'tool', name: 'f' })).toEqual({
      type: 'function',
      function: { name: 'f' },
    });
    expect(translateToolChoice({ type: 'weird' })).toBeUndefined();
    expect(translateToolChoice('auto')).toBeUndefined();
  });

  it('没有 tools 时不带 tool_choice（上游会因此报错）', () => {
    const out = translate({ model: 'a', messages: [], tool_choice: { type: 'any' } });
    expect(out).not.toHaveProperty('tool_choice');
  });
});

describe('flattenSystem / flattenToolResult', () => {
  it('flattenSystem 忽略非文本块与非法输入', () => {
    expect(flattenSystem([{ type: 'image' }, { type: 'text', text: 'ok' }])).toBe('ok');
    expect(flattenSystem(undefined)).toBe('');
    expect(flattenSystem(42)).toBe('');
  });

  it('flattenToolResult 只保留文本，图片被丢掉（OpenAI 的 tool 消息不收图）', () => {
    expect(
      flattenToolResult([
        { type: 'text', text: 'line1' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } },
        { type: 'text', text: 'line2' },
      ])
    ).toBe('line1\nline2');
    expect(flattenToolResult('plain')).toBe('plain');
    expect(flattenToolResult(undefined)).toBe('');
  });
});

describe('translateAnthropicRequest · 错误路径', () => {
  it('非法 JSON → ProtocolTranslateError', () => {
    expect(() =>
      translateAnthropicRequest(ENCODER.encode('not json'), {
        upstreamModel: 'm',
        stream: false,
      })
    ).toThrow(ProtocolTranslateError);
  });

  it('★ 自审补：错误文案是固定串，不回显调用方 body 的片段', () => {
    // V8 的 JSON 解析错误会把输入抄进 message（"Unexpected token 'o', \"sk-secret…\" …"），
    // 而这条 message 会原样进 400 响应体。
    const secret = 'sk-ant-should-never-be-echoed';
    try {
      translateAnthropicRequest(ENCODER.encode(`{"model":"a","x":${secret}}`), {
        upstreamModel: 'm',
        stream: false,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolTranslateError);
      expect((err as Error).message).toBe('request body is not valid JSON');
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('body 不是对象 → ProtocolTranslateError', () => {
    expect(() =>
      translateAnthropicRequest(ENCODER.encode('[1,2]'), { upstreamModel: 'm', stream: false })
    ).toThrow(ProtocolTranslateError);
  });

  it('缺 messages → ProtocolTranslateError（Anthropic 必填字段）', () => {
    expect(() => translate({ model: 'a' })).toThrow(ProtocolTranslateError);
  });
});
