/**
 * 两道闸门在管线里的接线（M5·T5.2 / T5.3 / T5.4）。
 *
 * 这里要证的不是闸门内部的判定（那在 `packages/llm-router` 的 budget-service /
 * rate-limit 单测里），而是**四种开关组合各自独立生效**、429 的信封与
 * `Retry-After`、以及被拦下的调用照样落一条 `llm_calls`（A5 对账）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  type Harness,
  jsonResponder,
  makeModel,
  makeSnapshot,
  SUBJECT,
  startFakeUpstream,
} from '../../test/harness.js';
import { createApp } from '../app.js';
import { SILENT_LOGGER } from '../deps.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  harness.upstream.setHandler(jsonResponder(200, '{"ok":true}'));
});

afterEach(async () => {
  await harness.close();
});

const post = (path = '/v1/messages') =>
  harness.fetch(path, { body: JSON.stringify({ model: 'claude-sonnet-4-6' }) });

describe('限流闸门（T5.3）', () => {
  it('★ 开关关闭（未装配）→ 闸门一次都不被调用，请求照常到上游', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(harness.gateCalls.rateLimit).toBe(0);
    expect(harness.upstream.requests).toHaveLength(1);
  });

  it('放行时继续走完整条管线', async () => {
    harness.setRateLimit({ allowed: true });
    expect((await post()).status).toBe(200);
    expect(harness.gateCalls.rateLimit).toBe(1);
    expect(harness.upstream.requests).toHaveLength(1);
  });

  it('★ 超限 → 429 + Retry-After，且**一个字节都不打上游**', async () => {
    harness.setRateLimit({ allowed: false, retryAfterSec: 42 });
    const res = await post();

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    await expect(res.json()).resolves.toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'too many requests, slow down' },
    });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('★ 被限流的调用也落一条 llm_calls（否则打满配额的令牌在报表里隐身）', async () => {
    harness.setRateLimit({ allowed: false, retryAfterSec: 5 });
    await post();

    expect(harness.recorder.records).toHaveLength(1);
    expect(harness.recorder.records[0]).toMatchObject({
      status: 'rate_limited',
      httpStatus: 429,
      errorCode: 'RATE_LIMITED',
      // body 还没解析，所以没有 alias——归属列仍然齐全。
      modelAlias: '',
      tokenId: 'tok-1',
      projectId: 'proj-1',
      runId: 'run-1',
      costUsd: '0.000000',
    });
  });

  it('count_tokens 同样受限流保护', async () => {
    harness.setRateLimit({ allowed: false, retryAfterSec: 5 });
    expect((await post('/v1/messages/count_tokens')).status).toBe(429);
  });

  it('★ /v1/models 不受限流影响（模型发现被挡住会让 Claude Code 起不来）', async () => {
    harness.setRateLimit({ allowed: false, retryAfterSec: 5 });
    const res = await harness.fetch('/v1/models', { method: 'GET', body: undefined });

    expect(res.status).toBe(200);
    expect(harness.gateCalls.rateLimit).toBe(0);
  });

  it('限流仍然在认证之后：没令牌先回 401，不消耗配额', async () => {
    harness.setSubject(null);
    harness.setRateLimit({ allowed: false, retryAfterSec: 5 });

    expect((await post()).status).toBe(401);
    expect(harness.gateCalls.rateLimit).toBe(0);
    expect(harness.recorder.records).toHaveLength(0);
  });
});

describe('预算闸门（T5.2）', () => {
  it('★ 开关关闭（未装配）→ 闸门一次都不被调用，请求照常到上游', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(harness.gateCalls.budget).toBe(0);
  });

  it('放行时继续走完整条管线', async () => {
    harness.setBudget({ allowed: true });
    expect((await post()).status).toBe(200);
    expect(harness.gateCalls.budget).toBe(1);
    expect(harness.upstream.requests).toHaveLength(1);
  });

  it('★ 超限 → 429 + Retry-After 取到窗口边界的秒数，且不打上游', async () => {
    harness.setBudget({
      allowed: false,
      reason: 'budget exceeded for project proj-1: 12.50/10.00 USD (window=day)',
      retryAfterSec: 3_600,
      scope: { subjectType: 'project', subjectId: 'proj-1' },
      window: 'day',
    });
    const res = await post();

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    await expect(res.json()).resolves.toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'budget exceeded for project proj-1: 12.50/10.00 USD (window=day)',
      },
    });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('★ 被预算拦下的调用落一条带 alias 与 provider 的 llm_calls', async () => {
    harness.setBudget({
      allowed: false,
      reason: 'over',
      retryAfterSec: 60,
      scope: { subjectType: 'global', subjectId: null },
      window: 'total',
    });
    await post();

    expect(harness.recorder.records[0]).toMatchObject({
      status: 'budget_exceeded',
      httpStatus: 429,
      errorCode: 'BUDGET_EXCEEDED',
      modelAlias: 'claude-sonnet-4-6',
      providerId: 'prov-1',
      upstreamModel: 'claude-sonnet-4-6',
    });
  });

  it('预算判定在路由之后：未知 alias 先回 404，不查预算', async () => {
    harness.setBudget({
      allowed: false,
      reason: 'over',
      retryAfterSec: 60,
      scope: { subjectType: 'global', subjectId: null },
      window: 'day',
    });
    const res = await harness.fetch('/v1/messages', {
      body: JSON.stringify({ model: 'nope' }),
    });

    expect(res.status).toBe(404);
    expect(harness.gateCalls.budget).toBe(0);
  });

  it('★ 闸门自己抛错 → 放行（可用性优先），并且照常转发', async () => {
    const upstream = await startFakeUpstream(jsonResponder(200, '{"ok":true}'));
    try {
      const app = createApp({
        catalog: {
          current: makeSnapshot({
            models: [makeModel()],
            providers: [
              {
                id: 'prov-1',
                name: 'anthropic-prod',
                protocol: 'anthropic',
                baseUrl: upstream.baseUrl,
                credentialId: 'cred-1',
                defaultHeaders: {},
                timeoutMs: 5_000,
              },
            ],
          }),
        },
        authenticator: { authenticate: async () => SUBJECT },
        recorder: { enqueue: () => {} },
        budget: {
          check: async () => {
            throw new Error('budget store exploded');
          },
        },
        privateKeyPem: harness.deps.privateKeyPem,
        logger: SILENT_LOGGER,
      });

      const res = await app.fetch(
        new Request('http://router.test/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer rt_caller' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        })
      );

      expect(res.status).toBe(200);
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await upstream.close();
    }
  });
});

describe('★ 两个开关互相独立（A6 的四种组合）', () => {
  it('限流开 / 预算关：限流生效，预算一次都不查', async () => {
    harness.setRateLimit({ allowed: false, retryAfterSec: 3 });
    expect((await post()).status).toBe(429);
    expect(harness.gateCalls.budget).toBe(0);
  });

  it('限流关 / 预算开：预算生效，限流一次都不查', async () => {
    harness.setBudget({
      allowed: false,
      reason: 'over',
      retryAfterSec: 7,
      scope: { subjectType: 'global', subjectId: null },
      window: 'day',
    });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(harness.gateCalls.rateLimit).toBe(0);
  });

  it('两个都开且都放行：请求到上游，两道闸门各查一次', async () => {
    harness.setRateLimit({ allowed: true });
    harness.setBudget({ allowed: true });
    expect((await post()).status).toBe(200);
    expect(harness.gateCalls).toEqual({ rateLimit: 1, budget: 1 });
  });

  it('两个都开且限流先拦：预算不再被查（限流坐在更早的位置）', async () => {
    harness.setRateLimit({ allowed: false, retryAfterSec: 3 });
    harness.setBudget({ allowed: true });
    expect((await post()).status).toBe(429);
    expect(harness.gateCalls).toEqual({ rateLimit: 1, budget: 0 });
  });

  it('两个都关：与 M4 的行为完全一致', async () => {
    expect((await post()).status).toBe(200);
    expect(harness.gateCalls).toEqual({ rateLimit: 0, budget: 0 });
  });
});

describe('429 在 OpenAI 面的信封（R5 §6.2）', () => {
  it('限流：error.code / error.type 都是 rate_limit_exceeded', async () => {
    const openai = await createHarness({ protocol: 'openai' });
    try {
      openai.setRateLimit({ allowed: false, retryAfterSec: 9 });
      const res = await openai.fetch('/v1/chat/completions', {
        body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('9');
      await expect(res.json()).resolves.toEqual({
        error: {
          message: 'too many requests, slow down',
          type: 'rate_limit_exceeded',
          code: 'rate_limit_exceeded',
          param: null,
        },
      });
    } finally {
      await openai.close();
    }
  });

  it('预算：同一套 429 形状，message 带 used/limit/window', async () => {
    const openai = await createHarness({ protocol: 'openai' });
    try {
      openai.setBudget({
        allowed: false,
        reason: 'budget exceeded for global *: 1.00/1.00 USD (window=total)',
        retryAfterSec: 3_600,
        scope: { subjectType: 'global', subjectId: null },
        window: 'total',
      });
      const res = await openai.fetch('/v1/chat/completions', {
        body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      });

      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: 'rate_limit_exceeded',
          message: 'budget exceeded for global *: 1.00/1.00 USD (window=total)',
        },
      });
    } finally {
      await openai.close();
    }
  });
});

describe('★ 上游错误体不被闸门改变（D10 回归）', () => {
  it('两道闸门都放行时，上游 429 的 body 与状态码原样透传，不换成网关信封', async () => {
    harness.setRateLimit({ allowed: true });
    harness.setBudget({ allowed: true });
    harness.upstream.setHandler((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '77' });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"upstream said so"}}');
    });

    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('77');
    await expect(res.text()).resolves.toBe(
      '{"type":"error","error":{"type":"rate_limit_error","message":"upstream said so"}}'
    );
  });
});
