/**
 * Tests for DELETE /api/v1/llm/credentials/:id（M2·T2.3）。
 *
 * 覆盖认证矩阵 + 两条业务规则：
 *   - 未知 id → 404
 *   - 仍被 provider 引用 → 409（FK restrict 的可行动版本）
 * 并断言删除成功后 bump 了目录版本位——否则副本会拿着一份已经不存在的凭据转发。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthenticate, mockHasScope, mockDeleteById, mockBumpCatalogVersion } = vi.hoisted(
  () => ({
    mockAuthenticate: vi.fn(),
    mockHasScope: vi.fn(),
    mockDeleteById: vi.fn(),
    mockBumpCatalogVersion: vi.fn(),
  })
);

vi.mock('@/lib/auth/unified-auth', () => ({
  authenticate: (req: Request) => mockAuthenticate(req),
  hasScope: (ctx: unknown, scope: string) => mockHasScope(ctx, scope),
}));

vi.mock('@open-rush/db', () => ({ getDbClient: () => ({}) }));

vi.mock('@open-rush/llm-router', () => ({
  seal: vi.fn(),
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleCredentialStore: class {
    deleteById = mockDeleteById;
  },
  CredentialNameConflictError: class extends Error {},
  CredentialInUseError: class extends Error {
    constructor(
      public credentialId: string,
      public providerCount: number
    ) {
      super(`credential ${credentialId} is referenced by ${providerCount} provider(s)`);
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: 'user-1', scopes: ['*'], authType: 'session' });
  mockHasScope.mockReturnValue(true);
  mockDeleteById.mockResolvedValue(true);
  mockBumpCatalogVersion.mockResolvedValue(2);
});

import { DELETE } from './route';

const ID = '00000000-0000-0000-0000-0000000000aa';
const req = () => new Request(`https://t/api/v1/llm/credentials/${ID}`, { method: 'DELETE' });
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/v1/llm/credentials/:id', () => {
  it('401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue(null);
    expect((await DELETE(req(), ctx())).status).toBe(401);
  });

  it('403 when missing scope llm:write', async () => {
    mockHasScope.mockReturnValue(false);
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(403);
    expect(mockHasScope).toHaveBeenCalledWith(expect.anything(), 'llm:write');
  });

  it('403 for service tokens (platform-scoped resource)', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'user-1',
      scopes: ['llm:write'],
      authType: 'service-token',
    });
    expect((await DELETE(req(), ctx())).status).toBe(403);
    expect(mockDeleteById).not.toHaveBeenCalled();
  });

  it('400 when the id is not a uuid', async () => {
    const res = await DELETE(req(), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(mockDeleteById).not.toHaveBeenCalled();
  });

  it('404 for an unknown credential, and does not bump the catalog', async () => {
    mockDeleteById.mockResolvedValue(false);
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(404);
    expect(mockBumpCatalogVersion).not.toHaveBeenCalled();
  });

  it('409 when the credential is still referenced by providers', async () => {
    const { CredentialInUseError } = await import('@open-rush/llm-router');
    mockDeleteById.mockRejectedValue(new CredentialInUseError(ID, 2));
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string; hint?: string } };
    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(body.error.message).toMatch(/2 provider\(s\)/);
    expect(body.error.hint).toMatch(/referencing providers/);
    expect(mockBumpCatalogVersion).not.toHaveBeenCalled();
  });

  it('200 and bumps the catalog on success', async () => {
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: ID, deleted: true } });
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });
});
