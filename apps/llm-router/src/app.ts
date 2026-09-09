/**
 * 网关的 Hono 装配（M4·T4.1，C7 §7.14）。
 *
 * 拆成 `createApp(deps)` 而不是在 `server.ts` 里就地 new：单测可以塞内存目录 +
 * 假认证器把整条管线跑通，不必起 PG，也不必造真令牌。
 *
 * 日志刻意只打 `method / path / status / requestId` 四个字段——**不打请求头、
 * 不打 body、不打上游 URL**。M6·T6.5 在这之上再包一层 {@link sanitizingLogger}：
 * `path` 是调用方能完全控制的字符串（`/v1/sk-ant-…` 这种请求随时会来），
 * 四字段少不代表四字段干净。
 */
import { createHonoMiddleware } from '@open-rush/observability/hono';
import { Hono } from 'hono';
import type { RouterDeps, RouterEnv } from './deps.js';
import { sanitizingLogger } from './log/sanitizing-logger.js';
import { authenticate } from './middleware/authenticate.js';
import { RATE_LIMITED_PATHS, rateLimit } from './middleware/rate-limit.js';
import { chatCompletionsRoutes } from './routes/chat-completions.js';
import { messagesRoutes } from './routes/messages.js';
import { modelsRoutes } from './routes/models.js';

export function createApp(deps: RouterDeps): Hono<RouterEnv> {
  const app = new Hono<RouterEnv>();
  // 即使 `server.ts` 传进来的已经是包过的，再包一次也是幂等的（清洗过的字符串
  // 不含可匹配的模式）——单测直接调 `createApp` 时才是这一层真正起作用的场合。
  const logger = deps.logger ? sanitizingLogger(deps.logger) : undefined;

  app.use('*', createHonoMiddleware('llm-router'));
  app.use('*', async (c, next) => {
    await next();
    logger?.info({
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
    });
  });

  // —— 探针 ——
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  /**
   * 就绪 = 目录快照已加载 **且** 没有在排空。
   * 私钥在 `main()` 里 fail-fast，走到这里就一定已经加载过了。
   */
  app.get('/readyz', (c) => {
    if (deps.isDraining?.()) return c.json({ ready: false, reason: 'draining' }, 503);
    const snapshot = deps.catalog.current;
    if (!snapshot) return c.json({ ready: false, reason: 'catalog not loaded' }, 503);
    return c.json({ ready: true, catalogVersion: snapshot.version });
  });

  // Claude Code 的连接预热探针。不实现会在日志里刷 404。
  app.on('HEAD', '/api/hello', (c) => c.body(null, 200));
  app.get('/api/hello', (c) => c.body(null, 200));

  // —— 业务面：全部要令牌（D12「没有钥匙就没有门」）——
  app.use('/v1/*', authenticate(deps.authenticator));
  // 限流只挂推理路由：模型发现不烧钱，被配额挡住只会让 Claude Code 起不来。
  for (const path of RATE_LIMITED_PATHS) app.use(path, rateLimit(deps));
  app.route('/v1', messagesRoutes(deps));
  app.route('/v1', chatCompletionsRoutes(deps));
  app.route('/v1', modelsRoutes(deps));

  return app;
}
