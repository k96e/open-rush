/**
 * 日志清洗单测（M6·T6.5，A9）。
 *
 * 要钉死的三件事：① 常见凭据形态都被换成 `[REDACTED]`；② 嵌套结构里的也一样；
 * ③ **不误伤**——把 requestId / path 这类正常字段也打码会让日志失去排障价值。
 */
import { describe, expect, it } from 'vitest';
import { containsSecrets, redactLogFields, redactSecrets, redactValue } from '../redact.js';

const ANTHROPIC_KEY = `sk-ant-api03-${'A'.repeat(40)}`;
const OPENAI_KEY = `sk-proj-${'B'.repeat(40)}`;
const ROUTER_TOKEN = `rt_${'C'.repeat(43)}`;

describe('redactSecrets', () => {
  it.each([
    ['Anthropic key', ANTHROPIC_KEY],
    ['OpenAI key', OPENAI_KEY],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub PAT', `ghp_${'a'.repeat(36)}`],
    ['GitHub OAuth', `gho_${'a'.repeat(36)}`],
    ['GitHub App token', `ghs_${'a'.repeat(36)}`],
    ['网关自己签发的调用方令牌', ROUTER_TOKEN],
  ])('%s 被换成 [REDACTED]', (_name, secret) => {
    const out = redactSecrets(`upstream said: ${secret} (end)`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(secret);
    expect(out.startsWith('upstream said: ')).toBe(true);
  });

  it('Authorization 头整段被打码', () => {
    expect(redactSecrets(`authorization: Bearer ${ROUTER_TOKEN}`)).not.toContain(ROUTER_TOKEN);
  });

  it('一段文本里的多个密钥全部被替换（正则的 lastIndex 不会漏第二个）', () => {
    const out = redactSecrets(`${ANTHROPIC_KEY} and ${ANTHROPIC_KEY}`);
    expect(out).toBe('[REDACTED] and [REDACTED]');
  });

  it('连着跑两次结果相同（幂等——出口包了两层也不会越洗越糊）', () => {
    const once = redactSecrets(`k=${ANTHROPIC_KEY}`);
    expect(redactSecrets(once)).toBe(once);
  });

  it.each([
    'GET /v1/messages 200',
    'req-01HX8Z9K3M4N5P6Q7R8S9T0V',
    'provider=anthropic-main model=claude-sonnet-4-5',
    '',
  ])('正常内容不被改动：%s', (text) => {
    expect(redactSecrets(text)).toBe(text);
    expect(containsSecrets(text)).toBe(false);
  });
});

describe('redactValue / redactLogFields', () => {
  it('provider name 里塞了一段 sk-ant → 日志里是 [REDACTED]（T6.5 的验收）', () => {
    const fields = redactLogFields({ provider: `evil-${ANTHROPIC_KEY}` });
    expect(fields.provider).toBe('evil-[REDACTED]');
  });

  it('嵌套对象与数组里的密钥同样被洗掉', () => {
    const out = redactLogFields({
      meta: { providers: [{ name: ANTHROPIC_KEY }] },
    }) as { meta: { providers: Array<{ name: string }> } };
    expect(out.meta.providers[0].name).toBe('[REDACTED]');
  });

  it('凭据类键名的值整体打码，不看它长什么样', () => {
    const out = redactLogFields({
      authorization: 'anything at all',
      'x-api-key': 'short',
      apiKey: 'short',
      password: 'hunter2',
      path: '/v1/messages',
    });
    expect(out.authorization).toBe('[REDACTED]');
    expect(out['x-api-key']).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    // 不误伤：正常字段原样保留，否则日志就没法排障了。
    expect(out.path).toBe('/v1/messages');
  });

  it('Error 实例转成 "name: message" 并清洗（直接塞进日志会变成 {}）', () => {
    const out = redactLogFields({ err: new Error(`upstream rejected ${ANTHROPIC_KEY}`) });
    expect(out.err).toBe('Error: upstream rejected [REDACTED]');
  });

  it('number / boolean / null / undefined 原样通过', () => {
    const out = redactLogFields({ status: 200, ok: true, err: null, extra: undefined });
    expect(out).toEqual({ status: 200, ok: true, err: null, extra: undefined });
  });

  it('自引用结构不会把日志线程转死（超过深度上限就整体字符串化）', () => {
    const cyclic: Record<string, unknown> = { name: ANTHROPIC_KEY };
    cyclic.self = cyclic;
    const out = redactValue(cyclic);
    expect(JSON.stringify(out)).not.toContain(ANTHROPIC_KEY);
  });
});
