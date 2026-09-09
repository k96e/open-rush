/**
 * 网关的 Hono 装配（M4·T4.1，C7 §7.14）。
 *
 * 拆成 `createApp(deps)` 而不是在 `server.ts` 里就地 new：单测可以塞内存目录 +
 * 假认证器把整条管线跑通，不必起 PG，也不必造真令牌。
 *
 * 日志刻意只打 `method / path / status / requestId` 四个字段——**不打请求头、
 * 不打 body、不打上游 URL**。这是 A9 在 M4 的落法：没有可泄漏的内容进日志，
 * 就不需要在这一层做清洗（`sanitize` 的接线归 M6·T6.5）。
 */
import { createHonoMiddleware } from '@open-rush/observability/hono';
import { Hono } from 'hono';
import type { RouterDeps, RouterEnv } from './deps.js';
import { authenticate } from './middleware/authenticate.js';
import { chatCompletionsRoutes } from './routes/chat-completions.js';
import { messagesRoutes } from './routes/messages.js';
import { modelsRoutes } from './routes/models.js';

export function createApp(deps: RouterDeps): Hono<RouterEnv> {
  const app = new Hono<RouterEnv>();

  app.use('*', createHonoMiddleware('llm-router'));
  app.use('*', async (c, next) => {
    await next();
    deps.logger?.info({
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
  app.route('/v1', messagesRoutes(deps));
  app.route('/v1', chatCompletionsRoutes(deps));
  app.route('/v1', modelsRoutes(deps));

  return app;
}
