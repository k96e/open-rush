import { describe, expect, it } from 'vitest';
import { ModelRewriteError, rewriteModelField } from '../model-rewrite.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const omitModel = (obj: Record<string, unknown>): Record<string, unknown> => {
  const { model: _model, ...rest } = obj;
  return rest;
};

describe('rewriteModelField', () => {
  const original = {
    model: 'sonnet-alias',
    max_tokens: 1024,
    stream: true,
    system: '你是一个助手 🌏',
    metadata: { user_id: 'u1', nested: { deep: [1, 2, { x: null }] } },
    tools: [{ name: 'bash', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    temperature: 0.7,
    stop_sequences: [],
  };

  it('★ 只改 $.model 一个字段：其余深度相等', () => {
    const before = ENCODER.encode(JSON.stringify(original));
    const after = rewriteModelField(before, 'claude-sonnet-4-6-20260101');

    const parsedBefore = JSON.parse(DECODER.decode(before)) as Record<string, unknown>;
    const parsedAfter = JSON.parse(DECODER.decode(after)) as Record<string, unknown>;

    expect(parsedAfter.model).toBe('claude-sonnet-4-6-20260101');
    expect(omitModel(parsedAfter)).toEqual(omitModel(parsedBefore));
  });

  it('不修改入参字节（上游请求与计量共用同一份原始 body）', () => {
    const before = ENCODER.encode(JSON.stringify(original));
    const copy = before.slice();
    rewriteModelField(before, 'other');
    expect(before).toEqual(copy);
  });

  it('原本没有 model 字段时也会写入（缺 model 的请求由路由层先挡掉）', () => {
    const after = rewriteModelField(ENCODER.encode('{"max_tokens":1}'), 'm');
    expect(JSON.parse(DECODER.decode(after))).toEqual({ max_tokens: 1, model: 'm' });
  });

  it('保持键的顺序（model 原地替换，不挪到末尾）', () => {
    const after = rewriteModelField(ENCODER.encode('{"a":1,"model":"x","z":2}'), 'y');
    expect(DECODER.decode(after)).toBe('{"a":1,"model":"y","z":2}');
  });

  it('多字节字符往返无损', () => {
    const after = rewriteModelField(
      ENCODER.encode(JSON.stringify({ model: 'a', text: '你好，世界 🌏' })),
      'b'
    );
    expect(JSON.parse(DECODER.decode(after)).text).toBe('你好，世界 🌏');
  });

  it.each([
    ['非法 JSON', '{not json'],
    ['空 body', ''],
  ])('%s → ModelRewriteError', (_label, body) => {
    expect(() => rewriteModelField(ENCODER.encode(body), 'm')).toThrow(ModelRewriteError);
  });

  it.each([
    ['数组', '[1,2,3]'],
    ['裸字符串', '"hello"'],
    ['null', 'null'],
  ])('顶层不是对象（%s）→ ModelRewriteError', (_label, body) => {
    expect(() => rewriteModelField(ENCODER.encode(body), 'm')).toThrow(/must be a JSON object/);
  });
});
