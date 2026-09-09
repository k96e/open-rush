/**
 * 日志出口清洗的接线测试（M6·T6.5，A9）。
 *
 * 单元层（正则本身）在 `packages/llm-router/src/log/__tests__/redact.test.ts`。
 * 这里要证的是**接上了**：包过的 logger 会洗，`createApp` 装的是包过的那个。
 */
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { RouterDeps, RouterLogger } from '../deps.js';
import { sanitizingLogger } from '../log/sanitizing-logger.js';

const ANTHROPIC_KEY = `sk-ant-api03-${'A'.repeat(40)}`;

function recordingLogger(): {
  logger: RouterLogger;
  calls: Array<[Record<string, unknown>, string | undefined]>;
} {
  const calls: Array<[Record<string, unknown>, string | undefined]> = [];
  const push = (obj: Record<string, unknown>, msg?: string) => {
    calls.push([obj, msg]);
  };
  return { logger: { info: push, warn: push, error: push }, calls };
}

describe('sanitizingLogger', () => {
  it('provider name 里的 sk-ant 走一遍日志后是 [REDACTED]', () => {
    const { logger, calls } = recordingLogger();
    sanitizingLogger(logger).warn({ provider: ANTHROPIC_KEY }, 'catalog refresh failed');
    expect(calls[0][0]).toEqual({ provider: '[REDACTED]' });
    expect(calls[0][1]).toBe('catalog refresh failed');
  });

  it('msg 本身也被清洗（凭据常常是被拼进消息文本的那一半）', () => {
    const { logger, calls } = recordingLogger();
    sanitizingLogger(logger).error({}, `upstream 401 for ${ANTHROPIC_KEY}`);
    expect(calls[0][1]).toBe('upstream 401 for [REDACTED]');
  });

  it('三个级别都包上了（漏一个就等于漏一条泄漏路径）', () => {
    const { logger, calls } = recordingLogger();
    const wrapped = sanitizingLogger(logger);
    wrapped.info({ k: ANTHROPIC_KEY });
    wrapped.warn({ k: ANTHROPIC_KEY });
    wrapped.error({ k: ANTHROPIC_KEY });
    expect(calls.map(([obj]) => obj)).toEqual([
      { k: '[REDACTED]' },
      { k: '[REDACTED]' },
      { k: '[REDACTED]' },
    ]);
  });

  it('没有 msg 时不会凭空造出一个 "undefined" 字符串', () => {
    const { logger, calls } = recordingLogger();
    sanitizingLogger(logger).info({ status: 200 });
    expect(calls[0][1]).toBeUndefined();
  });
});

describe('createApp 的访问日志', () => {
  function deps(logger: RouterLogger): RouterDeps {
    return {
      catalog: { current: null },
      authenticator: { authenticate: vi.fn(async () => null) },
      recorder: { enqueue: vi.fn() },
      privateKeyPem: 'unused',
      logger,
    };
  }

  it('path 是调用方能控制的字符串——里面的密钥进不了日志', async () => {
    const { logger, calls } = recordingLogger();
    const app = createApp(deps(logger));
    // 未认证 → 401，但访问日志照打，path 就是这一条被清洗的字符串。
    await app.request(`/v1/${ANTHROPIC_KEY}/messages`);
    const paths = calls.map(([obj]) => obj.path);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(String(path)).not.toContain(ANTHROPIC_KEY);
    }
    expect(paths.some((p) => String(p).includes('[REDACTED]'))).toBe(true);
  });
});
