/**
 * Tests for GET/PATCH/DELETE /api/v1/llm/models/:id（M3·T3.4）。
 *
 * A7 的主路径就在 PATCH 上——「改一行目录、不重启就生效」的前半段是这里的
 * bumpCatalogVersion，后半段是 CatalogCache。所以每个写 method 都断言 bump。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthenticate,
  mockHasScope,
  mockFindById,
  mockPatch,
  mockDeleteById,
  mockBumpCatalogVersion,
  ConflictError,
  ReferenceError_,
} = vi.hoisted(() => {
  class ConflictError extends Error {}
  class ReferenceError_ extends Error {}
  return {
    mockAuthenticate: vi.fn(),
    mockHasScope: vi.fn(),
    mockFindById: vi.fn(),
    mockPatch: vi.fn(),
    mockDeleteById: vi.fn(),
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

vi.mock('@open-rush/llm-router/store', () => ({
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleProviderStore: class {},
  DrizzleModelStore: class {
    findById = mockFindById;
    patch = mockPatch;
    deleteById = mockDeleteById;
  },
  CatalogConflictError: ConflictError,
  CatalogReferenceError: ReferenceError_,
}));

import { DELETE, GET, PATCH } from './route';

const ID = '00000000-0000-0000-0000-0000000000b1';

function fakeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    alias: 'claude-opus-5',
    providerId: '00000000-0000-0000-0000-0000000000a1',
    upstreamModel: 'claude-opus-5',
    priority: 0,
    enabled: true,
    displayName: null,
    maxOutputTokens: null,
    priceInputPerMtok: '0',
    priceOutputPerMtok: '0',
    priceCacheWritePerMtok: '0',
    priceCacheReadPerMtok: '0',
    priceReasoningPerMtok: '0',
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
  mockFindById.mockResolvedValue(fakeModel());
  mockPatch.mockResolvedValue(fakeModel({ enabled: false }));
  mockDeleteById.mockResolvedValue(true);
});

const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

function req(method: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://t/api/v1/llm/models/${ID}`, init);
}

describe('GET /api/v1/llm/models/:id', () => {
  it('returns the model', async () => {
    const res = await GET(req('GET'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: expect.objectContaining({ id: ID }) });
  });

  it('404 when missing', async () => {
    mockFindById.mockResolvedValue(null);
    expect((await GET(req('GET'), ctx())).status).toBe(404);
  });

  it('400 on a non-uuid id', async () => {
    expect((await GET(req('GET'), ctx('nope'))).status).toBe(400);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('401 without authentication and 403 without llm:read', async () => {
    mockAuthenticate.mockResolvedValue(null);
    expect((await GET(req('GET'), ctx())).status).toBe(401);

    mockAuthenticate.mockResolvedValue({ userId: 'u1', scopes: [], authType: 'session' });
    mockHasScope.mockReturnValue(false);
    expect((await GET(req('GET'), ctx())).status).toBe(403);
  });

  it('403 for a service token', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'u1',
      scopes: ['llm:read'],
      authType: 'service-token',
    });
    expect((await GET(req('GET'), ctx())).status).toBe(403);
  });
});

describe('PATCH /api/v1/llm/models/:id', () => {
  it('disables a model and bumps the catalog version (A7 main path)', async () => {
    const res = await PATCH(req('PATCH', { enabled: false }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: expect.objectContaining({ enabled: false }) });
    expect(mockPatch).toHaveBeenCalledWith(ID, { enabled: false });
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('400 on an empty patch', async () => {
    expect((await PATCH(req('PATCH', {}), ctx())).status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON', async () => {
    const res = await PATCH(
      new Request(`https://t/api/v1/llm/models/${ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
      ctx()
    );
    expect(res.status).toBe(400);
  });

  it('404 when the model is gone', async () => {
    mockPatch.mockResolvedValue(null);
    expect((await PATCH(req('PATCH', { priority: 1 }), ctx())).status).toBe(404);
    expect(mockBumpCatalogVersion).not.toHaveBeenCalled();
  });

  it('409 on an alias collision', async () => {
    mockPatch.mockRejectedValue(new ConflictError('alias taken'));
    expect((await PATCH(req('PATCH', { alias: 'taken' }), ctx())).status).toBe(409);
  });

  it('400 when moved onto an unknown provider', async () => {
    mockPatch.mockRejectedValue(new ReferenceError_('providerId x does not exist'));
    const res = await PATCH(
      req('PATCH', { providerId: '00000000-0000-0000-0000-0000000000ff' }),
      ctx()
    );
    expect(res.status).toBe(400);
  });

  it('403 without llm:write and 403 for a service token', async () => {
    mockHasScope.mockReturnValue(false);
    expect((await PATCH(req('PATCH', { enabled: false }), ctx())).status).toBe(403);

    mockHasScope.mockReturnValue(true);
    mockAuthenticate.mockResolvedValue({
      userId: 'u1',
      scopes: ['llm:write'],
      authType: 'service-token',
    });
    expect((await PATCH(req('PATCH', { enabled: false }), ctx())).status).toBe(403);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/llm/models/:id', () => {
  it('deletes and bumps the catalog version', async () => {
    const res = await DELETE(req('DELETE'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: ID, deleted: true } });
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('404 when nothing was deleted', async () => {
    mockDeleteById.mockResolvedValue(false);
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(404);
    expect(mockBumpCatalogVersion).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated and 403 for a service token', async () => {
    mockAuthenticate.mockResolvedValue(null);
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(401);

    mockAuthenticate.mockResolvedValue({
      userId: 'u1',
      scopes: ['llm:write'],
      authType: 'service-token',
    });
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(403);
    expect(mockDeleteById).not.toHaveBeenCalled();
  });
});
