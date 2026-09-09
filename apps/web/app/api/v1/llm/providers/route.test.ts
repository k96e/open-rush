/**
 * Tests for POST/GET /api/v1/llm/providers（M3·T3.4）。
 *
 * 每个 method 三类用例：正常 / 错误 / 权限拒绝。另加两条 M3 特有的：
 *  - 写成功后**一定**调了 bumpCatalogVersion（D7，漏掉就是副本永远看不到变更）
 *  - bump 失败不把已落库的写谎报成 500
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthenticate,
  mockHasScope,
  mockCreate,
  mockList,
  mockBumpCatalogVersion,
  ConflictError,
  ReferenceError_,
} = vi.hoisted(() => {
  class ConflictError extends Error {}
  class ReferenceError_ extends Error {}
  return {
    mockAuthenticate: vi.fn(),
    mockHasScope: vi.fn(),
    mockCreate: vi.fn(),
    mockList: vi.fn(),
    mockBumpCatalogVersion: vi.fn(),
    ConflictError,
    ReferenceError_,
  };
});

vi.mock('@/lib/auth/unified-auth', () => ({
  authenticate: (req: Request) => mockAuthenticate(req),
  hasScope: (ctx: unknown, scope: string) => mockHasScope(ctx, scope),
}));

vi.mock('@open-rush/db', () => ({ getDbClient: () => ({}) }));

vi.mock('@open-rush/llm-router', () => ({
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleProviderStore: class {
    create = mockCreate;
    list = mockList;
  },
  DrizzleModelStore: class {},
  CatalogConflictError: ConflictError,
  CatalogReferenceError: ReferenceError_,
}));

import { GET, POST } from './route';

function fakeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    name: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    credentialId: null,
    defaultHeaders: {},
    timeoutMs: 600_000,
    enabled: true,
    createdAt: new Date('2026-09-09T00:00:00.000Z'),
    updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: 'u1', scopes: ['*'], authType: 'session' });
  mockHasScope.mockReturnValue(true);
  mockBumpCatalogVersion.mockResolvedValue(1);
  mockCreate.mockResolvedValue(fakeProvider());
  mockList.mockResolvedValue({ items: [fakeProvider()], nextCursor: null });
});

function jsonReq(method: string, body?: unknown, url = 'https://t/api/v1/llm/providers'): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

const validBody = () => ({
  name: 'anthropic',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
});

describe('POST /api/v1/llm/providers', () => {
  it('creates a provider and bumps the catalog version', async () => {
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: expect.objectContaining({ name: 'anthropic', timeoutMs: 600_000, enabled: true }),
    });
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('applies contract defaults for timeoutMs / enabled / defaultHeaders', async () => {
    await POST(jsonReq('POST', validBody()));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 600_000, enabled: true, defaultHeaders: {} })
    );
  });

  it('still returns 201 when the version bump fails (row is already written)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBumpCatalogVersion.mockRejectedValue(new Error('db down'));
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(201);
    spy.mockRestore();
  });

  it('401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue(null);
    expect((await POST(jsonReq('POST', validBody()))).status).toBe(401);
  });

  it('403 without llm:write', async () => {
    mockHasScope.mockReturnValue(false);
    expect((await POST(jsonReq('POST', validBody()))).status).toBe(403);
  });

  it('403 for a service token', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'u1',
      scopes: ['llm:write'],
      authType: 'service-token',
    });
    expect((await POST(jsonReq('POST', validBody()))).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON', async () => {
    const res = await POST(
      new Request('https://t/api/v1/llm/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
    );
    expect(res.status).toBe(400);
  });

  it('400 on an unknown protocol', async () => {
    const res = await POST(jsonReq('POST', { ...validBody(), protocol: 'gemini' }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('409 on a duplicate name', async () => {
    mockCreate.mockRejectedValue(new ConflictError("provider 'anthropic' already exists"));
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(409);
    expect(mockBumpCatalogVersion).not.toHaveBeenCalled();
  });

  it('400 when credentialId points at nothing', async () => {
    mockCreate.mockRejectedValue(new ReferenceError_('credentialId x does not exist'));
    const res = await POST(
      jsonReq('POST', { ...validBody(), credentialId: '00000000-0000-0000-0000-0000000000ff' })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { issues: [{ path: ['credentialId'] }] },
    });
  });

  it('rethrows unexpected store errors', async () => {
    mockCreate.mockRejectedValue(new Error('boom'));
    await expect(POST(jsonReq('POST', validBody()))).rejects.toThrow('boom');
  });
});

describe('GET /api/v1/llm/providers', () => {
  it('lists providers', async () => {
    const res = await GET(jsonReq('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [expect.objectContaining({ name: 'anthropic' })],
      nextCursor: null,
    });
  });

  it('passes the enabled filter and pagination through', async () => {
    await GET(jsonReq('GET', undefined, 'https://t/api/v1/llm/providers?enabled=false&limit=5'));
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, limit: 5, cursor: undefined })
    );
  });

  it('400 on a non-boolean enabled param', async () => {
    const res = await GET(
      jsonReq('GET', undefined, 'https://t/api/v1/llm/providers?enabled=maybe')
    );
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue(null);
    expect((await GET(jsonReq('GET'))).status).toBe(401);
  });

  it('403 without llm:read', async () => {
    mockHasScope.mockReturnValue(false);
    expect((await GET(jsonReq('GET'))).status).toBe(403);
  });

  it('403 for a service token', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'u1',
      scopes: ['llm:read'],
      authType: 'service-token',
    });
    expect((await GET(jsonReq('GET'))).status).toBe(403);
  });
});
