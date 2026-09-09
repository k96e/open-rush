/**
 * catalog-helpers 单测（M3·T3.4）。
 *
 * 两个被四个路由文件共用的东西，各自值一组断言：
 *  - `requireLlmConsole` 的三层准入（认证 / scope / session-only）
 *  - `providerToV1` / `modelToV1` 的**投影边界**：领域行多长一个字段也不会漏进
 *    响应体（同 credentials 的 `credentialToV1()`）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthenticate, mockHasScope, mockBumpCatalogVersion } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockHasScope: vi.fn(),
  mockBumpCatalogVersion: vi.fn(),
}));

vi.mock('@/lib/auth/unified-auth', () => ({
  authenticate: (req: Request) => mockAuthenticate(req),
  hasScope: (ctx: unknown, scope: string) => mockHasScope(ctx, scope),
}));

vi.mock('@open-rush/db', () => ({ getDbClient: () => ({}) }));

vi.mock('@open-rush/llm-router/store', () => ({
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleProviderStore: class {},
  DrizzleModelStore: class {},
  CatalogConflictError: class extends Error {},
  CatalogReferenceError: class extends Error {},
}));

import {
  bumpCatalogAfterWrite,
  modelToV1,
  providerToV1,
  requireLlmConsole,
} from './catalog-helpers';

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: 'u1', scopes: ['*'], authType: 'session' });
  mockHasScope.mockReturnValue(true);
  mockBumpCatalogVersion.mockResolvedValue(1);
});

const req = () => new Request('https://t/api/v1/llm/providers');

describe('requireLlmConsole', () => {
  it('passes a scoped session through', async () => {
    const gate = await requireLlmConsole(req(), 'llm:read');
    expect(gate.error).toBeUndefined();
    expect(gate.auth?.userId).toBe('u1');
  });

  it('401s without authentication', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const gate = await requireLlmConsole(req(), 'llm:read');
    expect(gate.error?.status).toBe(401);
  });

  it('403s when the scope is missing', async () => {
    mockHasScope.mockReturnValue(false);
    const gate = await requireLlmConsole(req(), 'llm:write');
    expect(gate.error?.status).toBe(403);
    expect(mockHasScope).toHaveBeenCalledWith(expect.anything(), 'llm:write');
  });

  it('403s a service token even with the scope', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'u1',
      scopes: ['llm:write'],
      authType: 'service-token',
    });
    const gate = await requireLlmConsole(req(), 'llm:write');
    expect(gate.error?.status).toBe(403);
    expect(await gate.error?.json()).toMatchObject({
      error: { message: expect.stringContaining('platform-scoped') },
    });
  });
});

describe('bumpCatalogAfterWrite', () => {
  it('bumps the catalog version', async () => {
    await bumpCatalogAfterWrite('provider x');
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('swallows bump failures (the row is already written)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBumpCatalogVersion.mockRejectedValue(new Error('db down'));
    await expect(bumpCatalogAfterWrite('provider x')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('projections', () => {
  const now = new Date('2026-09-09T00:00:00.000Z');

  it('providerToV1 projects explicitly and drops unknown columns', () => {
    const dto = providerToV1({
      id: 'p1',
      name: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      credentialId: 'c1',
      defaultHeaders: { 'X-Tenant': 'rush' },
      timeoutMs: 600_000,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      // 将来 schema 多长一列也不该漏出去。
      secretSomething: 'MUST-NOT-LEAK',
    } as never);

    expect(dto).toEqual({
      id: 'p1',
      name: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      credentialId: 'c1',
      defaultHeaders: { 'X-Tenant': 'rush' },
      timeoutMs: 600_000,
      enabled: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(JSON.stringify(dto)).not.toContain('MUST-NOT-LEAK');
  });

  it('modelToV1 keeps numeric prices as strings', () => {
    const dto = modelToV1({
      id: 'm1',
      alias: 'claude-opus-5',
      providerId: 'p1',
      upstreamModel: 'claude-opus-5',
      priority: 0,
      enabled: true,
      displayName: null,
      maxOutputTokens: null,
      priceInputPerMtok: '3.500000',
      priceOutputPerMtok: '17.250000',
      priceCacheWritePerMtok: '0',
      priceCacheReadPerMtok: '0',
      priceReasoningPerMtok: '0',
      createdAt: now,
      updatedAt: now,
    } as never);

    expect(dto.priceInputPerMtok).toBe('3.500000');
    expect(typeof dto.priceOutputPerMtok).toBe('string');
    expect(dto.createdAt).toBe(now.toISOString());
  });
});
