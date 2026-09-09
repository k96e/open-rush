/**
 * 探针与装配（M4·T4.1）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, makeSnapshot } from '../../test/harness.js';

let harness: Harness;

afterEach(async () => {
  await harness?.close();
});

describe('探针', () => {
  it('GET /healthz → 200，只查进程', async () => {
    harness = await createHarness();
    const res = await harness.fetch('/healthz', { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('healthz 不需要令牌（负载均衡探针不带凭据）', async () => {
    harness = await createHarness();
    harness.setSubject(null);
    expect((await harness.fetch('/healthz', { method: 'GET', headers: {} })).status).toBe(200);
  });

  it('GET /readyz → 200 且带 catalogVersion', async () => {
    harness = await createHarness();
    const res = await harness.fetch('/readyz', { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ready: true, catalogVersion: 1 });
  });

  it('★ 目录未加载时 readyz → 503（摘流）', async () => {
    harness = await createHarness();
    harness.setSnapshot(null);
    const res = await harness.fetch('/readyz', { method: 'GET', headers: {} });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ready: false, reason: 'catalog not loaded' });
  });

  it('★ 排空中时 readyz → 503（优雅退出，A3）', async () => {
    harness = await createHarness();
    harness.setDraining(true);
    const res = await harness.fetch('/readyz', { method: 'GET', headers: {} });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ready: false, reason: 'draining' });
  });

  it('★ HEAD /api/hello → 200（Claude Code 的连接预热探针）', async () => {
    harness = await createHarness();
    const res = await harness.fetch('/api/hello', { method: 'HEAD', headers: {} });
    expect(res.status).toBe(200);
  });

  it('GET /api/hello 也回 200', async () => {
    harness = await createHarness();
    expect((await harness.fetch('/api/hello', { method: 'GET', headers: {} })).status).toBe(200);
  });

  it('每个响应都带 x-request-id', async () => {
    harness = await createHarness();
    const res = await harness.fetch('/healthz', { method: 'GET', headers: {} });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('调用方传来的 x-request-id 被沿用（便于跨服务对齐）', async () => {
    harness = await createHarness();
    const res = await harness.fetch('/healthz', {
      method: 'GET',
      headers: { 'x-request-id': 'req-from-caller' },
    });
    expect(res.headers.get('x-request-id')).toBe('req-from-caller');
  });

  it('未知路径 → 404（Hono 默认），不泄露任何目录信息', async () => {
    harness = await createHarness();
    const res = await harness.fetch('/v1/nope', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('claude-sonnet-4-6');
  });

  it('空目录快照下 readyz 仍然 ready（版本位有效即可）', async () => {
    harness = await createHarness();
    harness.setSnapshot(makeSnapshot({ models: [], providers: [], version: 7 }));
    const res = await harness.fetch('/readyz', { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ready: true, catalogVersion: 7 });
  });
});
