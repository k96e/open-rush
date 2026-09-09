/**
 * 限流闸门（M5·T5.3）。
 *
 * 复用的 `RedisRateLimiter` 自己已经有单测（`packages/agent-runtime`），这里只证
 * 本文件补的三件事：key 选择、`Retry-After` 的取值、以及 Redis 故障时**降级放行**。
 *
 * 假 Redis 直接实现 `eval`——被测的正是那两段 Lua 的调用方式（脚本本身跑在真
 * Redis 上，集成测试归 M7）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Subject } from '../../auth/token-store.js';
import {
  RATE_LIMIT_FALLBACK_RETRY_AFTER_SEC,
  RATE_LIMIT_KEY_PREFIX,
  RouterRateLimiter,
  rateLimitKey,
} from '../rate-limit.js';

function subject(over: Partial<Subject> = {}): Subject {
  return {
    tokenId: 'tok-1',
    subjectType: 'run',
    runId: 'run-1',
    agentId: null,
    projectId: 'proj-1',
    ownerUserId: null,
    allowedModelAliases: [],
    maxCostUsd: null,
    maxRequestsPerMinute: null,
    ...over,
  };
}

interface Call {
  script: string;
  args: (string | number)[];
}

/** 一个只认「滑动窗口脚本」与「读最老分数脚本」的假 Redis。 */
function fakeRedis(opts: {
  acquire?: boolean | (() => boolean);
  oldest?: number;
  throwOn?: 'acquire' | 'oldest';
}) {
  const calls: Call[] = [];
  return {
    calls,
    async eval(script: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
      calls.push({ script, args });
      const isOldest = script.includes('ZRANGE');
      if (opts.throwOn === 'oldest' && isOldest) throw new Error('redis is down');
      if (opts.throwOn === 'acquire' && !isOldest) throw new Error('redis is down');
      if (isOldest) return opts.oldest ?? -1;
      const acquire = opts.acquire ?? true;
      return (typeof acquire === 'function' ? acquire() : acquire) ? 1 : 0;
    },
  };
}

describe('rateLimitKey', () => {
  it('有项目归属时按项目（同项目多 run 共享配额）', () => {
    expect(rateLimitKey(subject())).toBe('project:proj-1');
  });

  it('没有项目归属时退化到令牌', () => {
    expect(rateLimitKey(subject({ projectId: null }))).toBe('token:tok-1');
  });
});

describe('RouterRateLimiter.check', () => {
  it('未超限 → 放行，且只打一次 Redis', async () => {
    const redis = fakeRedis({ acquire: true });
    const limiter = new RouterRateLimiter({ redis, defaultRpm: 10 });

    await expect(limiter.check(subject())).resolves.toEqual({ allowed: true });
    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0].args[0]).toBe(`${RATE_LIMIT_KEY_PREFIX}:project:proj-1`);
    expect(redis.calls[0].args[1]).toBe(10);
  });

  it('★ 超限 → 拒绝，Retry-After 取窗口剩余时间', async () => {
    // 最老那次调用在 20 秒前 → 还要 40 秒才滑出 60 秒窗口。
    const redis = fakeRedis({ acquire: false, oldest: Date.now() - 20_000 });
    const decision = await new RouterRateLimiter({ redis, defaultRpm: 1 }).check(subject());

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.retryAfterSec).toBeGreaterThanOrEqual(39);
    expect(decision.retryAfterSec).toBeLessThanOrEqual(40);
  });

  it('Retry-After 至少 1 秒：窗口已空或刚好到点也不回 0', async () => {
    const justExpired = fakeRedis({ acquire: false, oldest: Date.now() - 60_000 });
    const d1 = await new RouterRateLimiter({ redis: justExpired, defaultRpm: 1 }).check(subject());
    expect(d1).toEqual({ allowed: false, retryAfterSec: 1 });

    const empty = fakeRedis({ acquire: false, oldest: -1 });
    const d2 = await new RouterRateLimiter({ redis: empty, defaultRpm: 1 }).check(subject());
    expect(d2).toEqual({ allowed: false, retryAfterSec: 1 });
  });

  it('Retry-After 不超过一个窗口', async () => {
    // 时钟漂移导致的未来分数：不能因此回一个荒唐的秒数。
    const redis = fakeRedis({ acquire: false, oldest: Date.now() + 600_000 });
    const decision = await new RouterRateLimiter({ redis, defaultRpm: 1 }).check(subject());
    expect(decision).toEqual({
      allowed: false,
      retryAfterSec: RATE_LIMIT_FALLBACK_RETRY_AFTER_SEC,
    });
  });

  it('令牌自带的 max_requests_per_minute 覆盖默认配额', async () => {
    const redis = fakeRedis({ acquire: true });
    await new RouterRateLimiter({ redis, defaultRpm: 10 }).check(
      subject({ maxRequestsPerMinute: 3 })
    );
    expect(redis.calls[0].args[1]).toBe(3);
  });

  it('配额非正数视为不限制，一次 Redis 都不打', async () => {
    const redis = fakeRedis({ acquire: false });
    const limiter = new RouterRateLimiter({ redis, defaultRpm: 0 });
    await expect(limiter.check(subject())).resolves.toEqual({ allowed: true });
    expect(redis.calls).toHaveLength(0);
  });

  it('★ Redis 不可达 → 降级放行 + 告警（可用性优先）', async () => {
    const onError = vi.fn();
    const limiter = new RouterRateLimiter({
      redis: fakeRedis({ throwOn: 'acquire' }),
      defaultRpm: 10,
      onError,
    });

    await expect(limiter.check(subject())).resolves.toEqual({ allowed: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('读窗口剩余时间失败时仍然拒绝，Retry-After 用兜底值', async () => {
    const onError = vi.fn();
    const limiter = new RouterRateLimiter({
      redis: fakeRedis({ acquire: false, throwOn: 'oldest' }),
      defaultRpm: 1,
      onError,
    });

    await expect(limiter.check(subject())).resolves.toEqual({
      allowed: false,
      retryAfterSec: RATE_LIMIT_FALLBACK_RETRY_AFTER_SEC,
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('自定义 keyPrefix 同时作用于取配额与读剩余时间两条脚本', async () => {
    const redis = fakeRedis({ acquire: false, oldest: Date.now() });
    await new RouterRateLimiter({ redis, defaultRpm: 1, keyPrefix: 'custom' }).check(subject());
    expect(redis.calls.map((c) => c.args[0])).toEqual([
      'custom:project:proj-1',
      'custom:project:proj-1',
    ]);
  });

  it('不同项目各自计数（key 不同）', async () => {
    const redis = fakeRedis({ acquire: true });
    const limiter = new RouterRateLimiter({ redis, defaultRpm: 5 });
    await limiter.check(subject({ projectId: 'p-a' }));
    await limiter.check(subject({ projectId: 'p-b' }));
    expect(redis.calls.map((c) => c.args[0])).toEqual([
      `${RATE_LIMIT_KEY_PREFIX}:project:p-a`,
      `${RATE_LIMIT_KEY_PREFIX}:project:p-b`,
    ]);
  });
});
