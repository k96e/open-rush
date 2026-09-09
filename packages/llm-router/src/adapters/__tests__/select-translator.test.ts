/**
 * 翻译器注册表（M4·T4.7）。
 *
 * 这里钉死的是**交付边界**：只有 anthropic → openai 一个方向存在，
 * 其余组合返回 null，路由层据此维持 404。
 */
import { describe, expect, it } from 'vitest';
import { anthropicToOpenAiTranslator, selectTranslator } from '../select-translator.js';

describe('selectTranslator', () => {
  it('anthropic 面 + openai 上游 → 有翻译器', () => {
    const t = selectTranslator('anthropic', 'openai');
    expect(t).not.toBeNull();
    expect(t?.face).toBe('anthropic');
    expect(t?.upstream).toBe('openai');
  });

  it('★ 反方向未交付 → null（明确拒绝好过半成品的翻译）', () => {
    expect(selectTranslator('openai', 'anthropic')).toBeNull();
  });

  it('同协议 → null（本该走 passthrough / rewrite-model）', () => {
    expect(selectTranslator('anthropic', 'anthropic')).toBeNull();
    expect(selectTranslator('openai', 'openai')).toBeNull();
  });

  it('上游端点换成 /v1/chat/completions，且不带调用方 query', () => {
    expect(anthropicToOpenAiTranslator().upstreamPath).toBe('/v1/chat/completions');
  });
});
