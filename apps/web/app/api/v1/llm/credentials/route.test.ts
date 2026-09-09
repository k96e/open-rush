/**
 * Tests for POST/GET /api/v1/llm/credentials（M2·T2.3）。
 *
 * 除了常规的认证/校验矩阵，重点是三条盲写不变量的运行时断言：
 *   - 响应体序列化后**检索不到** `sealedValue` / `value` / 明文子串
 *   - 明文只出现在 `seal()` 的入参上，落库的是密文
 *   - 公钥缺失 → INTERNAL 500（服务端配置错误），不是 400
 *
 * 平台级资源 → service token 一律 403（照抄 vaults 的 `scope=platform` 处理）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockAuthenticate, mockHasScope, mockCreate, mockList, mockBumpCatalogVersion, mockSeal } =
  vi.hoisted(() => ({
    mockAuthenticate: vi.fn(),
    mockHasScope: vi.fn(),
    mockCreate: vi.fn(),
    mockList: vi.fn(),
    mockBumpCatalogVersion: vi.fn(),
    mockSeal: vi.fn(),
  }));

vi.mock('@/lib/auth/unified-auth', () => ({
  authenticate: (req: Request) => mockAuthenticate(req),
  hasScope: (ctx: unknown, scope: string) => mockHasScope(ctx, scope),
}));

vi.mock('@open-rush/db', () => ({
  getDbClient: () => ({}),
}));

// 真实的 seal 会被单独测（packages/llm-router）；这里替身让我们能断言
// 「明文只作为 seal 的入参出现过一次」。
vi.mock('@open-rush/llm-router', () => ({
  seal: (pem: string, plaintext: string) => mockSeal(pem, plaintext),
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleCredentialStore: class {
    create = mockCreate;
    list = mockList;
  },
  CredentialNameConflictError: class extends Error {
    constructor(public credentialName: string) {
      super(`credential '${credentialName}' already exists`);
    }
  },
  CredentialInUseError: class extends Error {
    constructor(
      public credentialId: string,
      public providerCount: number
    ) {
      super('in use');
    }
  },
}));

// 不带尾随换行：`resolveRouterPublicKey()` 会 trim，断言按 trim 后的值来。
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAtest\n-----END PUBLIC KEY-----';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LLM_ROUTER_PUBLIC_KEY = PUBLIC_KEY_PEM;
  mockAuthenticate.mockResolvedValue({ userId: 'user-1', scopes: ['*'], authType: 'session' });
  mockHasScope.mockReturnValue(true);
  mockBumpCatalogVersion.mockResolvedValue(1);
  mockSeal.mockReturnValue({
    alg: 'x25519-hkdf-sha256-aes256gcm',
    keyId: 'ec97ab88a496b4f7b9e4d0ab8d980d37',
    value: 'SEALED-CIPHERTEXT-BASE64',
  });
  mockCreate.mockResolvedValue(fakeCredential());
  mockList.mockResolvedValue({ items: [fakeCredential()], nextCursor: null });
});

// Import AFTER mocks.
import { GET, POST } from './route';

const PLAINTEXT = 'sk-ant-api03-PLAINTEXT-NEVER-ECHOED';

function fakeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    name: 'anthropic-prod',
    alg: 'x25519-hkdf-sha256-aes256gcm',
    keyId: 'ec97ab88a496b4f7b9e4d0ab8d980d37',
    authStyle: 'bearer',
    authHeader: null,
    version: 1,
    createdBy: 'user-1',
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
    rotatedAt: null,
    ...overrides,
  };
}

function jsonReq(
  method: string,
  body?: unknown,
  url = 'https://t/api/v1/llm/credentials'
): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

const validBody = () => ({ name: 'anthropic-prod', value: PLAINTEXT });

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe('POST /api/v1/llm/credentials', () => {
  it('401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(401);
    expect(mockSeal).not.toHaveBeenCalled();
  });

  it('403 when missing scope llm:write', async () => {
    mockHasScope.mockReturnValue(false);
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(403);
    expect(mockHasScope).toHaveBeenCalledWith(expect.anything(), 'llm:write');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('403 when a service token tries to create a credential', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'user-1',
      scopes: ['llm:write'],
      authType: 'service-token',
    });
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(403);
    // 明文连 seal 都没走到——鉴权失败时不应该碰它。
    expect(mockSeal).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400 for invalid JSON', async () => {
    const req = new Request('https://t/api/v1/llm/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect((await POST(req)).status).toBe(400);
  });

  it('400 when the schema rejects the body', async () => {
    // name 不是小写 kebab
    expect((await POST(jsonReq('POST', { name: 'Anthropic_Prod', value: PLAINTEXT }))).status).toBe(
      400
    );
    // value 太短
    expect((await POST(jsonReq('POST', { name: 'anthropic-prod', value: 'short' }))).status).toBe(
      400
    );
    // authStyle=header 却没给 authHeader
    expect((await POST(jsonReq('POST', { ...validBody(), authStyle: 'header' }))).status).toBe(400);
    expect(mockSeal).not.toHaveBeenCalled();
  });

  it('500 INTERNAL with a hint when LLM_ROUTER_PUBLIC_KEY is missing', async () => {
    process.env.LLM_ROUTER_PUBLIC_KEY = '';
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.hint).toMatch(/LLM_ROUTER_PUBLIC_KEY/);
    // 配置错时不得留下半条记录。
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('500 INTERNAL when the configured public key is malformed, without echoing the plaintext', async () => {
    mockSeal.mockImplementation(() => {
      throw new Error('unsupported key type');
    });
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain(PLAINTEXT);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('201 stores only the ciphertext and never echoes the plaintext', async () => {
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(201);

    // seal 拿到的是明文；store 拿到的只有密文。
    expect(mockSeal).toHaveBeenCalledWith(PUBLIC_KEY_PEM, PLAINTEXT);
    const stored = mockCreate.mock.calls[0][0];
    expect(stored.sealedValue).toBe('SEALED-CIPHERTEXT-BASE64');
    expect(JSON.stringify(stored)).not.toContain(PLAINTEXT);
    expect(stored.createdBy).toBe('user-1');

    // 响应体里既没有明文，也没有密文，更没有承载它们的字段名。
    const raw = await res.text();
    expect(raw).not.toContain(PLAINTEXT);
    expect(raw).not.toContain('SEALED-CIPHERTEXT-BASE64');
    expect(raw).not.toContain('sealedValue');
    expect(raw).not.toContain('sealed_value');
    expect(raw).not.toContain('"value"');

    const body = JSON.parse(raw) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      id: '00000000-0000-0000-0000-0000000000aa',
      name: 'anthropic-prod',
      alg: 'x25519-hkdf-sha256-aes256gcm',
      keyId: 'ec97ab88a496b4f7b9e4d0ab8d980d37',
      authStyle: 'bearer',
      authHeader: null,
      version: 1,
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
      rotatedAt: null,
    });
  });

  it('bumps the catalog version after a successful write', async () => {
    await POST(jsonReq('POST', validBody()));
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('still returns 201 (and logs) when the catalog bump fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBumpCatalogVersion.mockRejectedValue(new Error('catalog state missing'));
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(201);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('accepts a base64-wrapped public key', async () => {
    process.env.LLM_ROUTER_PUBLIC_KEY = Buffer.from(PUBLIC_KEY_PEM, 'utf8').toString('base64');
    await POST(jsonReq('POST', validBody()));
    expect(mockSeal).toHaveBeenCalledWith(PUBLIC_KEY_PEM, PLAINTEXT);
  });

  it('409 VERSION_CONFLICT on a duplicate name', async () => {
    const { CredentialNameConflictError } = await import('@open-rush/llm-router');
    mockCreate.mockRejectedValue(new CredentialNameConflictError('anthropic-prod'));
    const res = await POST(jsonReq('POST', validBody()));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(body.error.hint).toMatch(/rotate/);
  });

  it('passes authStyle=header through with its authHeader', async () => {
    await POST(
      jsonReq('POST', { ...validBody(), authStyle: 'header', authHeader: 'x-goog-api-key' })
    );
    const stored = mockCreate.mock.calls[0][0];
    expect(stored.authStyle).toBe('header');
    expect(stored.authHeader).toBe('x-goog-api-key');
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /api/v1/llm/credentials', () => {
  it('401 when unauthenticated', async () => {
    mockAuthenticate.mockResolvedValue(null);
    expect((await GET(jsonReq('GET'))).status).toBe(401);
  });

  it('403 when missing scope llm:read', async () => {
    mockHasScope.mockReturnValue(false);
    const res = await GET(jsonReq('GET'));
    expect(res.status).toBe(403);
    expect(mockHasScope).toHaveBeenCalledWith(expect.anything(), 'llm:read');
  });

  it('403 for service tokens (platform-scoped resource)', async () => {
    mockAuthenticate.mockResolvedValue({
      userId: 'user-1',
      scopes: ['llm:read'],
      authType: 'service-token',
    });
    expect((await GET(jsonReq('GET'))).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('400 when the pagination query is invalid', async () => {
    const res = await GET(jsonReq('GET', undefined, 'https://t/api/v1/llm/credentials?limit=999'));
    expect(res.status).toBe(400);
  });

  it('200 returns the projection only — no ciphertext anywhere in the body', async () => {
    mockList.mockResolvedValue({
      items: [fakeCredential(), fakeCredential({ id: 'bb', name: 'openai-prod' })],
      nextCursor: 'CURSOR-2',
    });
    const res = await GET(jsonReq('GET'));
    expect(res.status).toBe(200);

    const raw = await res.text();
    expect(raw).not.toContain('sealedValue');
    expect(raw).not.toContain('sealed_value');
    expect(raw).not.toContain('SEALED-CIPHERTEXT-BASE64');

    const body = JSON.parse(raw) as { data: Array<Record<string, unknown>>; nextCursor: string };
    expect(body.nextCursor).toBe('CURSOR-2');
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'alg',
      'authHeader',
      'authStyle',
      'createdAt',
      'id',
      'keyId',
      'name',
      'rotatedAt',
      'updatedAt',
      'version',
    ]);
    // createdBy 是领域字段，不在 v1 契约里——投影必须把它挡掉。
    expect(body.data[0].createdBy).toBeUndefined();
  });

  it('forwards limit and cursor to the store', async () => {
    await GET(jsonReq('GET', undefined, 'https://t/api/v1/llm/credentials?limit=5&cursor=abc'));
    expect(mockList).toHaveBeenCalledWith({ limit: 5, cursor: 'abc' });
  });
});
