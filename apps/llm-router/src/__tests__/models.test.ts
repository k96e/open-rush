/**
 * `GET /v1/models`（M4·T4.5）。
 *
 * 硬要求：同步返回、不重定向、只列这枚令牌能用的模型。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  type Harness,
  makeModel,
  makeSnapshot,
  SUBJECT,
} from '../../test/harness.js';

let harness: Harness;

const PROVIDER = {
  id: 'prov-1',
  name: 'anthropic-prod',
  protocol: 'anthropic' as const,
  baseUrl: 'http://127.0.0.1:1',
  credentialId: 'cred-1',
  defaultHeaders: {},
  timeoutMs: 5000,
};

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

const get = (path = '/v1/models') =>
  harness.fetch(path, { method: 'GET', headers: { authorization: 'Bearer rt_caller' } });

describe('GET /v1/models', () => {
  it('返回 { data: [{ id, display_name }] }', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }],
    });
  });

  it('★ 不重定向，且同步返回（无 3xx、无 Location）', async () => {
    const res = await get();
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('location')).toBeNull();
  });

  it('displayName 为空时用 alias 兜底', async () => {
    harness.setSnapshot(
      makeSnapshot({ models: [makeModel({ displayName: null })], providers: [PROVIDER] })
    );
    await expect(get().then((r) => r.json())).resolves.toEqual({
      data: [{ id: 'claude-sonnet-4-6', display_name: 'claude-sonnet-4-6' }],
    });
  });

  it('按 alias 排序，同名多候选只出现一次', async () => {
    harness.setSnapshot(
      makeSnapshot({
        models: [
          makeModel({ id: 'm1', alias: 'zeta' }),
          makeModel({ id: 'm2', alias: 'alpha' }),
          makeModel({ id: 'm3', alias: 'alpha', priority: 5 }),
        ],
        providers: [PROVIDER],
      })
    );
    const body = (await get().then((r) => r.json())) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(['alpha', 'zeta']);
  });

  it('★ 只列令牌白名单里的 alias', async () => {
    harness.setSnapshot(
      makeSnapshot({
        models: [makeModel({ id: 'm1', alias: 'a' }), makeModel({ id: 'm2', alias: 'b' })],
        providers: [PROVIDER],
      })
    );
    harness.setSubject({ ...SUBJECT, allowedModelAliases: ['b'] });
    const body = (await get().then((r) => r.json())) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(['b']);
  });

  it('支持 ?limit=（R5 要求能接住 limit=1000）', async () => {
    harness.setSnapshot(
      makeSnapshot({
        models: [
          makeModel({ id: 'm1', alias: 'a' }),
          makeModel({ id: 'm2', alias: 'b' }),
          makeModel({ id: 'm3', alias: 'c' }),
        ],
        providers: [PROVIDER],
      })
    );
    const body = (await get('/v1/models?limit=2').then((r) => r.json())) as {
      data: Array<{ id: string }>;
    };
    expect(body.data.map((m) => m.id)).toEqual(['a', 'b']);
    const all = (await get('/v1/models?limit=1000').then((r) => r.json())) as {
      data: unknown[];
    };
    expect(all.data).toHaveLength(3);
  });

  it.each(['0', '-1', 'abc', ''])('非法 limit=%s 回落到默认值而不是 400', async (limit) => {
    const body = (await get(`/v1/models?limit=${limit}`).then((r) => r.json())) as {
      data: unknown[];
    };
    expect(body.data).toHaveLength(1);
  });

  it('无令牌 → 401（模型目录也是运营信息）', async () => {
    harness.setSubject(null);
    const res = await harness.fetch('/v1/models', { method: 'GET', headers: {} });
    expect(res.status).toBe(401);
  });

  it('目录未加载 → 200 空列表（而不是 500：模型发现失败会让客户端直接罢工）', async () => {
    harness.setSnapshot(null);
    const res = await get();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: [] });
  });

  it('不写 llm_calls（不是一次上游调用）', async () => {
    await get();
    expect(harness.recorder.records).toHaveLength(0);
  });
});
