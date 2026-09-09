/**
 * llm-router 服务进程（M4·T4.1，C7 §7.14，D11 / A3）。
 *
 * 启动顺序刻意如此：
 *  ① 私钥 **fail-fast**——起不来好过带着「能转发但不能解封」的半残状态跑，
 *     那会让每一次真实调用都在上游认证处才炸；
 *  ② 目录首次加载失败**不致命**——`readyz` 会因此摘流，轮询会继续重试，
 *     启动期的 DB 抖动不该让副本直接退出。
 *
 * 优雅退出：SIGTERM → `readyz` 立刻 503（负载均衡摘流）→ 等在途流跑完 →
 * 关监听 → 停目录订阅。滚动更新期间不中断在途请求（A3）。
 */
import { serve } from '@hono/node-server';
import { createNotificationListener, getDbClient } from '@open-rush/db';
import {
  CatalogCache,
  DrizzleCatalogStore,
  DrizzleTokenStore,
  loadRouterPrivateKey,
  NOOP_CALL_RECORDER,
  TokenAuthenticator,
} from '@open-rush/llm-router';
import { createLogger } from '@open-rush/observability';
import { createApp } from './app.js';

const log = createLogger({ service: 'llm-router' });

export async function main(): Promise<void> {
  // ① 私钥 fail-fast。只打指纹，绝不打任何密钥材料。
  const key = loadRouterPrivateKey();
  log.info({ keyId: key.keyId }, 'router key loaded');

  const db = getDbClient();
  const listener = createNotificationListener();
  const catalog = new CatalogCache(new DrizzleCatalogStore(db), listener, {
    pollMs: Number(process.env.LLM_CATALOG_POLL_MS ?? 5000),
    logger: {
      info: (msg, meta) => log.info({ meta }, msg),
      warn: (msg, meta) => log.warn({ meta }, msg),
    },
  });

  const authenticator = new TokenAuthenticator(new DrizzleTokenStore(db), {
    ttlMs: Number(process.env.LLM_ROUTER_TOKEN_TTL_MS ?? 15_000),
    onTouchError: (err) => log.warn({ err: String(err) }, 'failed to touch token last_used_at'),
  });

  let draining = false;
  const app = createApp({
    catalog,
    authenticator,
    // M5·T5.1 换成 CallRecorder + DrizzleCallStore；在那之前逐调用明细不落库。
    recorder: NOOP_CALL_RECORDER,
    privateKeyPem: key.privateKeyPem,
    isDraining: () => draining,
    logger: log,
  });

  await catalog.start();

  const port = Number.parseInt(process.env.PORT ?? '8790', 10);
  const server = serve({ fetch: app.fetch, port }, (info) =>
    log.info({ port: info.port }, 'llm-router listening')
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    draining = true; // readyz → 503，负载均衡开始摘流
    log.info({ signal }, 'draining');
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.DRAIN_TIMEOUT_MS ?? 30_000))
    );
    server.close();
    await catalog.stop();
    log.info({ signal }, 'llm-router stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// 只有作为入口被执行时才启动；被 import（例如单测）时不启动。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error({ err: String(err) }, 'llm-router failed to start');
    process.exit(1);
  });
}
