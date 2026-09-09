/**
 * 认证中间件的接线（M4·T4.2）。
 *
 * 这里用**真的** TokenAuthenticator + 一个假 TokenStore：要证的是「中间件把
 * 请求头交给了认证器、把 subject 放进了 context、401 按协议面成形」。
 * 令牌本身的语义（吊销/过期/哈希）由 packages 侧的两个单测覆盖。
 */
import { hashRouterToken, type Subject, TokenAuthenticator } from '@open-rush/llm-router';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { RouterDeps } from '../deps.js';

const SUBJECT: Subject = {
  tokenId: 'tok-1',
  subjectType: 'service',
  runId: null,
  agentId: null,
  projectId: null,
  ownerUserId: null,
  allowedModelAliases: [],
  maxCostUsd: null,
  maxRequestsPerMinute: null,
};

function setup(activeToken: string | null) {
  const findActiveByHash = vi.fn(async (hash: string) =>
    activeToken && hash === hashRouterToken(activeToken) ? SUBJECT : null
  );
  const deps: RouterDeps = {
    catalog: { current: null },
    authenticator: new TokenAuthenticator(
      { findActiveByHash, touchLastUsed: async () => {} },
      { ttlMs: 15_000 }
    ),
    recorder: { enqueue: () => {} },
    privateKeyPem: 'unused',
  };
  return { app: createApp(deps), findActiveByHash };
}

const call = (
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  path = '/v1/models'
) => app.fetch(new Request(`http://router.test${path}`, { method: 'GET', headers }));

describe('authenticate 中间件', () => {
  it('无认证头 → 401，且没查过库', async () => {
    const { app, findActiveByHash } = setup('rt_good');
    expect((await call(app, {})).status).toBe(401);
    expect(findActiveByHash).not.toHaveBeenCalled();
  });

  it('非 rt_ 前缀（例如误配了供应商真 key）→ 401，且没查过库', async () => {
    const { app, findActiveByHash } = setup('rt_good');
    expect((await call(app, { authorization: 'Bearer sk-ant-real' })).status).toBe(401);
    expect(findActiveByHash).not.toHaveBeenCalled();
  });

  it('Authorization: Bearer 形式能认', async () => {
    const { app } = setup('rt_good');
    expect((await call(app, { authorization: 'Bearer rt_good' })).status).toBe(200);
  });

  it('★ x-api-key 形式也能认（Claude Code 两种凭据变量都可能用）', async () => {
    const { app } = setup('rt_good');
    expect((await call(app, { 'x-api-key': 'rt_good' })).status).toBe(200);
  });

  it('未知令牌 → 401', async () => {
    const { app } = setup('rt_good');
    expect((await call(app, { authorization: 'Bearer rt_unknown' })).status).toBe(401);
  });

  it('已吊销 / 已过期（store 一律返回 null）→ 401', async () => {
    const { app } = setup(null);
    expect((await call(app, { authorization: 'Bearer rt_revoked' })).status).toBe(401);
  });

  it('★ 缓存命中不再打 DB', async () => {
    const { app, findActiveByHash } = setup('rt_good');
    await call(app, { authorization: 'Bearer rt_good' });
    await call(app, { authorization: 'Bearer rt_good' });
    await call(app, { authorization: 'Bearer rt_good' });
    expect(findActiveByHash).toHaveBeenCalledTimes(1);
  });

  it('★ 401 的错误体按协议面成形：Anthropic 面', async () => {
    const { app } = setup('rt_good');
    const res = await app.fetch(
      new Request('http://router.test/v1/messages', { method: 'POST', body: '{}' })
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
  });

  it('★ 401 的错误体按协议面成形：OpenAI 面', async () => {
    const { app } = setup('rt_good');
    const res = await app.fetch(
      new Request('http://router.test/v1/chat/completions', { method: 'POST', body: '{}' })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string }; type?: string };
    expect(body.error.code).toBe('invalid_api_key');
    expect(body.type).toBeUndefined();
  });

  it('探针不经过认证', async () => {
    const { app } = setup('rt_good');
    expect((await app.fetch(new Request('http://router.test/healthz'))).status).toBe(200);
    expect(
      (await app.fetch(new Request('http://router.test/api/hello', { method: 'HEAD' }))).status
    ).toBe(200);
  });
});
