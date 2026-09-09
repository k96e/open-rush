/**
 * Tests for POST/GET /api/v1/llm/models（M3·T3.4）。
 *
 * 除了三类常规用例，另加两条 M3 特有的：
 *  - 写成功后一定 bump 目录版本（D7）
 *  - 价目列全程是十进制字符串，不被 Number() 溜进来（drizzle numeric ↔ string）
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

vi.mock('@open-rush/llm-router/store', () => ({
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleProviderStore: class {},
  DrizzleModelStore: class {
    create = mockCreate;
    list = mockList;
  },
  CatalogConflictError: ConflictError,
  CatalogReferenceError: ReferenceError_,
}));

import { GET, POST } from './route';

const PROVIDER_ID = '00000000-0000-0000-0000-0000000000a1';

function fakeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-0000000000b1',
    alias: 'claude-opus-5',
    providerId: PROVIDER_ID,
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
  mockCreate.mockResolvedValue(fakeModel());
  mockList.mockResolvedValue({ items: [fakeModel()], nextCursor: 'CURSOR' });
});

function jsonReq(method: string, body?: unknown, url = 'https://t/api/v1/llm/models'): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

const validBody = () => ({
  alias: 'claude-opus-5',
  providerId: PROVIDER_ID,
  upstreamModel: 'claude-opus-5',
});

describe('POST /api/v1/llm/models', () => {
  it('creates a model and bumps the catalog version', async () => {
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: expect.objectContaining({ alias: 'claude-opus-5', priceInputPerMtok: '3.500000' }),
    });
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('defaults priority / enabled / prices per contract', async () => {
    await POST(jsonReq('POST', validBody()));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 0,
        enabled: true,
        displayName: null,
        maxOutputTokens: null,
        priceInputPerMtok: '0',
      })
    );
  });

  it('400 on a non-decimal price', async () => {
    const res = await POST(jsonReq('POST', { ...validBody(), priceInputPerMtok: 3.5 }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON', async () => {
    const res = await POST(
      new Request('https://t/api/v1/llm/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
    );
    expect(res.status).toBe(400);
  });

  it('409 on a duplicate (alias, providerId)', async () => {
    mockCreate.mockRejectedValue(new ConflictError('model alias already exists'));
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(409);
    expect(mockBumpCatalogVersion).not.toHaveBeenCalled();
  });

  it('400 when providerId points at nothing', async () => {
    mockCreate.mockRejectedValue(new ReferenceError_('providerId x does not exist'));
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { issues: [{ path: ['providerId'] }] } });
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
});

describe('GET /api/v1/llm/models', () => {
  it('lists models with the cursor echoed back', async () => {
    const res = await GET(jsonReq('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [expect.objectContaining({ alias: 'claude-opus-5' })],
      nextCursor: 'CURSOR',
    });
  });

  it('passes providerId / enabled filters through', async () => {
    await GET(
      jsonReq(
        'GET',
        undefined,
        `https://t/api/v1/llm/models?providerId=${PROVIDER_ID}&enabled=true&limit=10`
      )
    );
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PROVIDER_ID, enabled: true, limit: 10 })
    );
  });

  it('400 on a non-uuid providerId', async () => {
    const res = await GET(jsonReq('GET', undefined, 'https://t/api/v1/llm/models?providerId=nope'));
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
