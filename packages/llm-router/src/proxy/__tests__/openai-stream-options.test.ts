import { describe, expect, it } from 'vitest';
import { injectStreamIncludeUsage } from '../openai-stream-options.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const parse = (b: Uint8Array) => JSON.parse(DECODER.decode(b)) as Record<string, unknown>;
const encode = (o: unknown) => ENCODER.encode(JSON.stringify(o));

describe('injectStreamIncludeUsage', () => {
  it('没有 stream_options 时注入 { include_usage: true }', () => {
    const result = injectStreamIncludeUsage(encode({ model: 'm', stream: true, messages: [] }));
    expect(result.injected).toBe(true);
    expect(parse(result.body)).toEqual({
      model: 'm',
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });
  });

  it('已有 stream_options 但没有 include_usage → 只补这一个键', () => {
    const result = injectStreamIncludeUsage(encode({ stream_options: { other: 1 } }));
    expect(result.injected).toBe(true);
    expect(parse(result.body)).toEqual({ stream_options: { other: 1, include_usage: true } });
  });

  it('★ 调用方显式写了 include_usage: false → 不覆盖，也不改字节', () => {
    const body = encode({ stream_options: { include_usage: false } });
    const result = injectStreamIncludeUsage(body);
    expect(result.injected).toBe(false);
    expect(result.body).toBe(body);
  });

  it('include_usage 已是 true → 不重复改写', () => {
    const body = encode({ stream_options: { include_usage: true } });
    expect(injectStreamIncludeUsage(body)).toEqual({ body, injected: false });
  });

  it('除 stream_options 外其他字段深度相等', () => {
    const original = {
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: '你好 🌏' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      temperature: 0,
    };
    const result = injectStreamIncludeUsage(encode(original));
    const { stream_options: _injected, ...rest } = parse(result.body);
    expect(rest).toEqual(original);
  });

  it.each([
    ['非法 JSON', '{oops'],
    ['数组', '[1]'],
    ['裸字符串', '"x"'],
  ])('%s → 原样返回，不抛', (_label, raw) => {
    const body = ENCODER.encode(raw);
    expect(injectStreamIncludeUsage(body)).toEqual({ body, injected: false });
  });

  it('stream_options 是个非对象怪值 → 不动它，交给上游报错', () => {
    const body = encode({ stream_options: 'nope' });
    expect(injectStreamIncludeUsage(body)).toEqual({ body, injected: false });
  });
});
