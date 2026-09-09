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
  BatchingCallRecorder,
  BudgetService,
  type CallRecorder,
  CatalogCache,
  DrizzleBudgetStore,
  DrizzleCallStore,
  DrizzleCatalogStore,
  DrizzleTokenStore,
  loadRouterPrivateKey,
  NOOP_CALL_RECORDER,
  RouterRateLimiter,
  TokenAuthenticator,
} from '@open-rush/llm-router';
import { createLogger } from '@open-rush/observability';
import { createRedisClient } from '@open-rush/stream';
import { createApp } from './app.js';
import type { BudgetGate, RateLimitGate } from './deps.js';
import { sanitizingLogger } from './log/sanitizing-logger.js';

/**
 * 进程里**唯一**的日志出口，且已经过清洗（M6·T6.5，A9）。
 *
 * 下面几处打的是外部来的字符串——目录刷新的告警带 provider 名、两道闸门降级与
 * 计量批写失败带 `err`（里面可能有上游 URL 与响应片段）。包在出口上，这些调用点
 * 就不必各自记得清洗。
 */
const log = sanitizingLogger(createLogger({ service: 'llm-router' }));

/** `'false'` 才算关；其余（含未设置）都算开。 */
function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultOn;
  return raw !== 'false' && raw !== '0';
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

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

  // ③ 计量（M5·T5.1）。关掉时装 NOOP——转发路径的代码一行都不变。
  const batching = envFlag('LLM_ROUTER_METERING_ENABLED', true)
    ? new BatchingCallRecorder(new DrizzleCallStore(db), {
        batchSize: envNumber('LLM_ROUTER_METERING_BATCH_SIZE', 100),
        flushIntervalMs: envNumber('LLM_ROUTER_METERING_FLUSH_MS', 1_000),
        maxQueue: envNumber('LLM_ROUTER_METERING_MAX_QUEUE', 10_000),
        onError: (err, size) =>
          log.error({ err: String(err), size }, 'metering batch flush failed, records dropped'),
      })
    : null;
  batching?.start();
  const recorder: CallRecorder = batching ?? NOOP_CALL_RECORDER;

  // ④ 两道闸门。**互相独立**（A6）：任一装配失败或关闭，都不影响另一道。
  const budget: BudgetGate | undefined = envFlag('LLM_ROUTER_BUDGET_ENABLED', true)
    ? new BudgetService(new DrizzleBudgetStore(db), {
        cacheTtlMs: envNumber('LLM_ROUTER_BUDGET_CACHE_MS', 10_000),
        onError: (err) => log.warn({ err: String(err) }, 'budget lookup failed, allowing request'),
      })
    : undefined;

  let rateLimiter: RateLimitGate | undefined;
  if (envFlag('LLM_ROUTER_RATE_LIMIT_ENABLED', false)) {
    const redis = createRedisClient({
      url: process.env.REDIS_URL,
      sentinels: process.env.REDIS_SENTINELS,
      masterName: process.env.REDIS_MASTER_NAME,
      password: process.env.REDIS_PASSWORD,
    });
    if (redis) {
      rateLimiter = new RouterRateLimiter({
        redis,
        defaultRpm: envNumber('LLM_ROUTER_RATE_LIMIT_RPM', 600),
        onError: (err) => log.warn({ err: String(err) }, 'rate limiter degraded, allowing request'),
      });
    } else {
      // 开关开着却没有 Redis：不能静默当成「限流生效了」。
      log.warn({}, 'rate limit enabled but no redis configured, running without rate limit');
    }
  }

  let draining = false;
  const app = createApp({
    catalog,
    authenticator,
    recorder,
    rateLimiter,
    budget,
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
    // 排空计量队列——最后一批调用的账不该因为一次滚动更新就丢。
    await batching?.drain();
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
