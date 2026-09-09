/**
 * 限流中间件（M5·T5.3，D9 / A6）。
 *
 * 只挂在**推理路由**上，不挂 `/v1/models`：模型发现是 Claude Code 启动时的一次性
 * 探测，把它算进配额只会让配额用完时连模型列表都拉不到，而它并不烧钱。
 *
 * 挂在认证**之后**：限流 key 来自 subject（`project:` 优先，退化到 `token:`），
 * 而 subject 只能来自令牌（D6）——用请求头做 key 等于让沙箱自己决定限不限流。
 *
 * `deps.rateLimiter` 未装配 = 开关关闭，直接放行；与预算开关互相独立（A6）。
 * Redis 不可达时的降级放行在 `RouterRateLimiter` 内部，这一层看到的永远是决定。
 */
import type { MiddlewareHandler } from 'hono';
import type { RouterDeps, RouterEnv } from '../deps.js';
import { faceProtocolOf } from '../protocol-face.js';
import { reject } from '../reject.js';

/** 受限流保护的路径。与 `app.ts` 的挂载点同源。 */
export const RATE_LIMITED_PATHS = [
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/chat/completions',
] as const;

export function rateLimit(deps: RouterDeps): MiddlewareHandler<RouterEnv> {
  return async (c, next) => {
    const limiter = deps.rateLimiter;
    if (!limiter) return next();

    const startedAt = new Date();
    const t0 = performance.now();
    const decision = await limiter.check(c.get('subject'));
    if (decision.allowed) return next();

    // body 还没读，所以没有 alias 也没有路由——记一条只有归属的 rate_limited。
    return reject({
      c,
      deps,
      face: faceProtocolOf(new URL(c.req.url).pathname),
      kind: 'rate_limited',
      message: 'too many requests, slow down',
      alias: null,
      stream: false,
      errorCode: 'RATE_LIMITED',
      retryAfterSec: decision.retryAfterSec,
      startedAt,
      t0,
    });
  };
}
