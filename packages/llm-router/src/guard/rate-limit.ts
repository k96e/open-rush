/**
 * 限流闸门（M5·T5.3，C5 §7.13，D9 / A6）。
 *
 * **直接复用** `packages/agent-runtime` 的 `RedisRateLimiter`（R1 §2.5）：Redis Lua
 * 滑动窗口，多副本共享同一个计数，正确性已经考虑过。那个包整体是死代码，但这个类
 * 不是——重写一遍只会多一份要维护的 Lua。
 *
 * 本文件补的是它没有的两件事：
 *  ① **`Retry-After`**。`tryAcquire()` 只回 true/false，而 R5 §6.2 要求 429 一律带
 *     秒数，且限流场景取「滑动窗口剩余时间」。所以拒绝路径上多一次 `ZRANGE`
 *     读最老成员的分数——只在拒绝时发生，正常路径一次往返都不多。
 *  ② **降级放行**。Redis 不可达时放行并告警（可用性优先，M5 阶段文件「易踩坑」）：
 *     限流是止损手段，让它在故障时把所有 LLM 调用打死是更坏的结果。
 *
 * key 优先取 projectId（同项目多 run 共享配额），退化到 tokenId。
 */
import { type RedisClient, RedisRateLimiter } from '@open-rush/agent-runtime';
import type { Subject } from '../auth/token-store.js';

/** 与 `RedisRateLimiter` 内部的窗口一致（它写死 60s）。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_KEY_PREFIX = 'llm_router_rate';
/** 读不到窗口剩余时间时的兜底 `Retry-After`（秒）。 */
export const RATE_LIMIT_FALLBACK_RETRY_AFTER_SEC = 60;

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

/**
 * 滑动窗口里最老那次调用的时间戳（毫秒）。窗口为空回 -1。
 *
 * 这就是 `RedisRateLimiter` 用的那个 ZSET，成员的 score 即入窗时间。
 */
const OLDEST_SCORE_SCRIPT = `
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if #oldest == 0 then return -1 end
return tonumber(oldest[2])
`;

export interface RouterRateLimiterOptions {
  redis: RedisClient;
  /** 令牌没有 `maxRequestsPerMinute` 时用的默认配额。 */
  defaultRpm: number;
  keyPrefix?: string;
  /** Redis 故障的告警回调（**降级放行**，不影响返回值）。 */
  onError?: (err: unknown) => void;
}

/** 限流 key：同项目的多个 run 共享配额；没有项目归属的服务令牌按令牌算。 */
export function rateLimitKey(subject: Subject): string {
  return subject.projectId ? `project:${subject.projectId}` : `token:${subject.tokenId}`;
}

export class RouterRateLimiter {
  private readonly keyPrefix: string;

  constructor(private readonly opts: RouterRateLimiterOptions) {
    this.keyPrefix = opts.keyPrefix ?? RATE_LIMIT_KEY_PREFIX;
  }

  async check(subject: Subject): Promise<RateLimitDecision> {
    const rpm = subject.maxRequestsPerMinute ?? this.opts.defaultRpm;
    // 非正数 = 不限制。想彻底禁用一个令牌应该吊销它，而不是把配额配成 0。
    if (!Number.isFinite(rpm) || rpm <= 0) return { allowed: true };

    const identifier = rateLimitKey(subject);
    const limiter = new RedisRateLimiter(this.opts.redis, {
      maxRequestsPerMinute: rpm,
      keyPrefix: this.keyPrefix,
    });

    try {
      if (await limiter.tryAcquire(identifier)) return { allowed: true };
    } catch (err) {
      this.opts.onError?.(err);
      return { allowed: true }; // 降级放行
    }

    return { allowed: false, retryAfterSec: await this.retryAfterSec(identifier) };
  }

  /** 最老那次调用滑出窗口还要多久。读不到就用兜底值。 */
  private async retryAfterSec(identifier: string): Promise<number> {
    try {
      const raw = await this.opts.redis.eval(
        OLDEST_SCORE_SCRIPT,
        1,
        `${this.keyPrefix}:${identifier}`
      );
      const oldest = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(oldest) || oldest < 0) return 1;
      const remainMs = oldest + RATE_LIMIT_WINDOW_MS - Date.now();
      // 至少 1 秒：回 0 会让客户端立刻重试，那时窗口多半还没滑动。
      return Math.min(RATE_LIMIT_FALLBACK_RETRY_AFTER_SEC, Math.max(1, Math.ceil(remainMs / 1000)));
    } catch (err) {
      this.opts.onError?.(err);
      return RATE_LIMIT_FALLBACK_RETRY_AFTER_SEC;
    }
  }
}
