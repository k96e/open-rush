/**
 * Tests for POST /api/v1/llm/credentials/:id/rotate（M2·T2.3）。
 *
 * 轮换是 A8 的兑现点，所以除了认证矩阵，重点断言：
 *   - 新明文只作为 seal 的入参出现，落库的是新密文
 *   - 响应体不含明文 / 密文 / 密文字段名
 *   - 成功后 bump 目录版本位（否则副本会继续用旧密钥转发）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthenticate, mockHasScope, mockRotate, mockBumpCatalogVersion, mockSeal } = vi.hoisted(
  () => ({
    mockAuthenticate: vi.fn(),
    mockHasScope: vi.fn(),
    mockRotate: vi.fn(),
    mockBumpCatalogVersion: vi.fn(),
    mockSeal: vi.fn(),
  })
);

vi.mock('@/lib/auth/unified-auth', () => ({
  authenticate: (req: Request) => mockAuthenticate(req),
  hasScope: (ctx: unknown, scope: string) => mockHasScope(ctx, scope),
}));

vi.mock('@open-rush/db', () => ({ getDbClient: () => ({}) }));

vi.mock('@open-rush/llm-router', () => ({
  seal: (pem: string, plaintext: string) => mockSeal(pem, plaintext),
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleCredentialStore: class {
    rotate = mockRotate;
  },
  CredentialNameConflictError: class extends Error {},
  CredentialInUseError: class extends Error {},
}));

// 不带尾随换行：`resolveRouterPublicKey()` 会 trim，断言按 trim 后的值来。
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAtest\n-----END PUBLIC KEY-----';
const NEW_PLAINTEXT = 'sk-ant-api03-ROTATED-PLAINTEXT';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LLM_ROUTER_PUBLIC_KEY = PUBLIC_KEY_PEM;
  mockAuthenticate.mockResolvedValue({ userId: 'user-1', scopes: ['*'], authType: 'session' });
  mockHasScope.mockReturnValue(true);
  mockBumpCatalogVersion.mockResolvedValue(3);
  mockSeal.mockReturnValue({
    alg: 'x25519-hkdf-sha256-aes256gcm',
    keyId: 'ec97ab88a496b4f7b9e4d0ab8d980d37',
    value: 'NEW-SEALED-CIPHERTEXT',
  });
  mockRotate.mockResolvedValue({
    id: ID,
    name: 'anthropic-prod',
    alg: 'x25519-hkdf-sha256-aes256gcm',
    keyId: 'ec97ab88a496b4f7b9e4d0ab8d980d37',
    authStyle: 'bearer',
    authHeader: null,
    version: 2,
    createdBy: 'user-1',
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T01:00:00.000Z'),
    rotatedAt: new Date('2026-09-08T01:00:00.000Z'),
  });
});

import { POST } from './route';

const ID = '00000000-0000-0000-0000-0000000000aa';

function req(body?: unknown): Request {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://t/api/v1/llm/credentials/${ID}/rotate`, init);
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

describe('POST /api/v1/llm/credentials/:id/rotate', () => {
  it('401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue(null);
    expect((await POST(req({ value: NEW_PLAINTEXT }), ctx())).status).toBe(401);
    expect(mockSeal).not.toHaveBeenCalled();
  });

  it('403 when missing scope llm:write', async () => {
    mockHasScope.mockReturnValue(false);
    const res = await POST(req({ value: NEW_PLAINTEXT }), ctx());
    expect(res.status).toBe(403);
    expect(mockHasScope).toHaveBeenCalledWith(expect.anything(), 'llm:write');
  });

  it('403 for service tokens (platform-scoped resource)', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'user-1',
      scopes: ['llm:write'],
      authType: 'service-token',
    });
    expect((await POST(req({ value: NEW_PLAINTEXT }), ctx())).status).toBe(403);
    expect(mockSeal).not.toHaveBeenCalled();
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('400 when the id is not a uuid', async () => {
    const res = await POST(req({ value: NEW_PLAINTEXT }), ctx('nope'));
    expect(res.status).toBe(400);
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('400 for invalid JSON and for a too-short value', async () => {
    const bad = new Request(`https://t/api/v1/llm/credentials/${ID}/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect((await POST(bad, ctx())).status).toBe(400);
    expect((await POST(req({ value: 'short' }), ctx())).status).toBe(400);
    expect(mockSeal).not.toHaveBeenCalled();
  });

  it('500 INTERNAL when LLM_ROUTER_PUBLIC_KEY is missing', async () => {
    process.env.LLM_ROUTER_PUBLIC_KEY = '';
    const res = await POST(req({ value: NEW_PLAINTEXT }), ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('INTERNAL');
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('404 for an unknown credential, and does not bump the catalog', async () => {
    mockRotate.mockResolvedValue(null);
    const res = await POST(req({ value: NEW_PLAINTEXT }), ctx());
    expect(res.status).toBe(404);
    expect(mockBumpCatalogVersion).not.toHaveBeenCalled();
  });

  it('200 overwrites the ciphertext, bumps version, and never echoes the plaintext', async () => {
    const res = await POST(req({ value: NEW_PLAINTEXT }), ctx());
    expect(res.status).toBe(200);

    expect(mockSeal).toHaveBeenCalledWith(PUBLIC_KEY_PEM, NEW_PLAINTEXT);
    expect(mockRotate).toHaveBeenCalledWith(ID, {
      alg: 'x25519-hkdf-sha256-aes256gcm',
      keyId: 'ec97ab88a496b4f7b9e4d0ab8d980d37',
      sealedValue: 'NEW-SEALED-CIPHERTEXT',
    });

    const raw = await res.text();
    expect(raw).not.toContain(NEW_PLAINTEXT);
    expect(raw).not.toContain('NEW-SEALED-CIPHERTEXT');
    expect(raw).not.toContain('sealedValue');
    expect(raw).not.toContain('"value"');

    const body = JSON.parse(raw) as { data: Record<string, unknown> };
    expect(body.data.version).toBe(2);
    expect(body.data.rotatedAt).toBe('2026-09-08T01:00:00.000Z');
    expect(body.data.createdBy).toBeUndefined();
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });
});
