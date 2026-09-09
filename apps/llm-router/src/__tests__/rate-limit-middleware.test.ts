/**
 * 限流中间件本身（M5·T5.3）。
 *
 * `gates.test.ts` 证的是它在整条管线里的位置；这里证的是中间件自己的形状：
 * 未装配时透明放行、拒绝时不进入下游 handler、以及受保护路径清单与 `app.ts`
 * 的挂载点同源。
 */
import { NOOP_CALL_RECORDER, type Subject } from '@open-rush/llm-router';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { KEYPAIR, SUBJECT } from '../../test/harness.js';
import type { RouterDeps, RouterEnv } from '../deps.js';
import { SILENT_LOGGER } from '../deps.js';
import { RATE_LIMITED_PATHS, rateLimit } from '../middleware/rate-limit.js';

function appWith(deps: Partial<RouterDeps>, subject: Subject | null = SUBJECT) {
  const full: RouterDeps = {
    catalog: { current: null },
    authenticator: { authenticate: async () => subject },
    recorder: NOOP_CALL_RECORDER,
    privateKeyPem: KEYPAIR.privateKeyPem,
    logger: SILENT_LOGGER,
    ...deps,
  };
  const app = new Hono<RouterEnv>();
  app.use('/v1/messages', async (c, next) => {
    c.set('subject', subject as Subject);
    c.set('requestId', 'req-mw');
    await next();
  });
  app.use('/v1/messages', rateLimit(full));
  app.post('/v1/messages', (c) => c.json({ reached: true }));
  return app;
}

const call = (app: Hono<RouterEnv>) =>
  app.fetch(new Request('http://router.test/v1/messages', { method: 'POST' }));

describe('rateLimit 中间件', () => {
  it('未装配限流器 → 透明放行', async () => {
    const res = await call(appWith({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reached: true });
  });

  it('放行时把请求交给下游 handler', async () => {
    const check = vi.fn(async () => ({ allowed: true }) as const);
    const res = await call(appWith({ rateLimiter: { check } }));
    expect(res.status).toBe(200);
    expect(check).toHaveBeenCalledWith(SUBJECT);
  });

  it('★ 拒绝时下游 handler 完全不执行', async () => {
    const res = await call(
      appWith({ rateLimiter: { check: async () => ({ allowed: false, retryAfterSec: 12 }) } })
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    await expect(res.json()).resolves.toMatchObject({ type: 'error' });
  });

  it('拒绝时把 requestId 带回响应头（两侧日志对齐）', async () => {
    const res = await call(
      appWith({ rateLimiter: { check: async () => ({ allowed: false, retryAfterSec: 1 }) } })
    );
    expect(res.headers.get('x-request-id')).toBe('req-mw');
  });

  it('计量抛错也不影响 429 的返回（A5）', async () => {
    const res = await call(
      appWith({
        rateLimiter: { check: async () => ({ allowed: false, retryAfterSec: 1 }) },
        recorder: {
          enqueue: () => {
            throw new Error('recorder exploded');
          },
        },
      })
    );
    expect(res.status).toBe(429);
  });

  it('受保护路径清单就是三条推理路由（不含 /v1/models）', () => {
    expect([...RATE_LIMITED_PATHS]).toEqual([
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/v1/chat/completions',
    ]);
  });
});
