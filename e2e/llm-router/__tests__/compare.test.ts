import { describe, expect, it } from 'vitest';
import {
  bytesEqual,
  deepEqualExcept,
  firstDiffAt,
  omitKeys,
  sseEventTypes,
  sseText,
  stableStringify,
} from '../lib/compare.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('bytesEqual / firstDiffAt', () => {
  it('长度与内容都相同才算相等', () => {
    expect(bytesEqual(bytes('abc'), bytes('abc'))).toBe(true);
    expect(bytesEqual(bytes('abc'), bytes('abd'))).toBe(false);
    expect(bytesEqual(bytes('abc'), bytes('abcd'))).toBe(false);
  });

  it('多字节字符按字节比，不按码点', () => {
    expect(bytesEqual(bytes('等于 2 🚀'), bytes('等于 2 🚀'))).toBe(true);
    expect(firstDiffAt(bytes('等于 2 🚀'), bytes('等于 3 🚀'))).toBe(7);
  });

  it('完全相同返回 -1；长度不同返回较短者的长度', () => {
    expect(firstDiffAt(bytes('abc'), bytes('abc'))).toBe(-1);
    expect(firstDiffAt(bytes('abc'), bytes('abcd'))).toBe(3);
  });

  it('空数组是相等的', () => {
    expect(bytesEqual(new Uint8Array(), new Uint8Array())).toBe(true);
    expect(firstDiffAt(new Uint8Array(), new Uint8Array())).toBe(-1);
  });
});

describe('stableStringify', () => {
  it('键序不影响结果', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('递归排序嵌套对象，但保留数组顺序', () => {
    expect(stableStringify({ x: [{ b: 1, a: 2 }] })).toBe('{"x":[{"a":2,"b":1}]}');
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('原始值与 null 照常序列化', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('中文')).toBe('"中文"');
    expect(stableStringify(3)).toBe('3');
  });
});

describe('deepEqualExcept / omitKeys', () => {
  const before = {
    model: 'alias',
    max_tokens: 8,
    messages: [{ role: 'user', content: '中文 🚀' }],
  };

  it('忽略 $.model 后深度相等 —— rewrite-model 档的判定口径', () => {
    const after = { ...before, model: 'upstream-model' };
    expect(deepEqualExcept(before, after, ['model'])).toBe(true);
  });

  it('除 $.model 外任何一处不同都判不等', () => {
    const tampered = { ...before, model: 'x', max_tokens: 9 };
    expect(deepEqualExcept(before, tampered, ['model'])).toBe(false);
  });

  it('嵌套里的同名键不受影响（只忽略顶层）', () => {
    const a = { model: 'a', meta: { model: 'inner-1' } };
    const b = { model: 'b', meta: { model: 'inner-2' } };
    expect(deepEqualExcept(a, b, ['model'])).toBe(false);
  });

  it('omitKeys 对数组与原始值原样返回', () => {
    expect(omitKeys([1, 2], ['model'])).toEqual([1, 2]);
    expect(omitKeys('x', ['model'])).toBe('x');
    expect(omitKeys(null, ['model'])).toBeNull();
  });
});

describe('sseEventTypes', () => {
  it('优先读 data 里的 $.type（Anthropic 面）', () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {"type":"ping"}\n\n';
    expect(sseEventTypes(sse)).toEqual(['message_start', 'ping']);
  });

  it('OpenAI chunk 没有 type，退化成占位但保留顺序与块数', () => {
    const sse =
      'data: {"id":"1","choices":[]}\n\ndata: {"id":"2","choices":[]}\n\ndata: [DONE]\n\n';
    expect(sseEventTypes(sse)).toEqual(['data', 'data', '[DONE]']);
  });

  it('data 不是 JSON 时退回 event: 行', () => {
    expect(sseEventTypes('event: weird\ndata: not-json\n\n')).toEqual(['weird']);
  });

  it('空串与纯空白返回空数组', () => {
    expect(sseEventTypes('')).toEqual([]);
    expect(sseEventTypes('\n\n\n')).toEqual([]);
  });
});

describe('sseText', () => {
  it('拼接 Anthropic 的 text_delta', () => {
    const sse =
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"等于 "}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"2 🚀"}}\n\n';
    expect(sseText(sse)).toBe('等于 2 🚀');
  });

  it('拼接 OpenAI 的 delta.content', () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n\n';
    expect(sseText(sse)).toBe('ab');
  });

  it('忽略非 JSON 块与没有文本的块', () => {
    expect(sseText('data: nope\n\ndata: {"type":"ping"}\n\n')).toBe('');
  });
});
