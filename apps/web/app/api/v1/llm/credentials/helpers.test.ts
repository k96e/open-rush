/**
 * Tests for the `/api/v1/llm/credentials/*` helpers（M2·T2.3）。
 *
 * 路由测试已经覆盖了这些函数在 HTTP 语境下的表现；这一份直接打函数边界，
 * 把「投影不漏字段」「公钥两种写法」「bump 失败不炸」这三条钉死，
 * 免得将来有人改了实现、只靠路由测试的宽松断言就滑过去。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSeal, mockBumpCatalogVersion } = vi.hoisted(() => ({
  mockSeal: vi.fn(),
  mockBumpCatalogVersion: vi.fn(),
}));

vi.mock('@open-rush/db', () => ({ getDbClient: () => ({}) }));

vi.mock('@open-rush/llm-router/sealing', () => ({
  seal: (pem: string, plaintext: string) => mockSeal(pem, plaintext),
}));

vi.mock('@open-rush/llm-router/store', () => ({
  bumpCatalogVersion: (db: unknown) => mockBumpCatalogVersion(db),
  DrizzleCredentialStore: class {},
  CredentialNameConflictError: class extends Error {},
  CredentialInUseError: class extends Error {},
}));

import {
  bumpCatalogAfterWrite,
  credentialToV1,
  resolveRouterPublicKey,
  sealCredentialValue,
} from './helpers';

const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAtest\n-----END PUBLIC KEY-----';

beforeEach(() => {
  vi.clearAllMocks();
  mockSeal.mockReturnValue({ alg: 'alg', keyId: 'kid', value: 'CIPHERTEXT' });
  mockBumpCatalogVersion.mockResolvedValue(1);
});

describe('resolveRouterPublicKey', () => {
  it('returns a PEM as-is', () => {
    const resolved = resolveRouterPublicKey(PEM);
    expect(resolved.publicKeyPem).toBe(PEM);
    expect(resolved.error).toBeUndefined();
  });

  it('decodes a base64-wrapped PEM', () => {
    const b64 = Buffer.from(PEM, 'utf8').toString('base64');
    expect(resolveRouterPublicKey(b64).publicKeyPem).toBe(PEM);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveRouterPublicKey(`\n  ${PEM}  \n`).publicKeyPem).toBe(PEM);
  });

  it('returns an INTERNAL 500 with a hint when unset or blank', async () => {
    for (const value of [undefined, '', '   ']) {
      const resolved = resolveRouterPublicKey(value);
      expect(resolved.publicKeyPem).toBeUndefined();
      const res = resolved.error as Response;
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; hint?: string } };
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.hint).toMatch(/pnpm llm:keygen/);
    }
  });
});

describe('sealCredentialValue', () => {
  it('returns the envelope produced by seal()', () => {
    const result = sealCredentialValue(PEM, 'sk-ant-plaintext');
    expect(result.envelope).toEqual({ alg: 'alg', keyId: 'kid', value: 'CIPHERTEXT' });
    expect(mockSeal).toHaveBeenCalledWith(PEM, 'sk-ant-plaintext');
  });

  it('maps a seal() failure to INTERNAL without echoing the plaintext', async () => {
    mockSeal.mockImplementation(() => {
      throw new Error('unsupported key type');
    });
    const result = sealCredentialValue('garbage', 'sk-ant-SECRET-PLAINTEXT');
    expect(result.envelope).toBeUndefined();
    const res = result.error as Response;
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('sk-ant-SECRET-PLAINTEXT');
    expect(raw).toContain('unsupported key type');
  });
});

describe('credentialToV1', () => {
  const domain = {
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
  };

  it('projects exactly the v1 keys — createdBy and anything else is dropped', () => {
    const wire = credentialToV1(domain);
    expect(Object.keys(wire).sort()).toEqual([
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
  });

  it('never carries a ciphertext even if the domain object grows one', () => {
    // 显式投影的意义就在这里：领域对象多长了一个字段，线上形状也不会变。
    const withCiphertext = { ...domain, sealedValue: 'LEAKED-CIPHERTEXT' };
    const wire = credentialToV1(withCiphertext);
    expect(JSON.stringify(wire)).not.toContain('LEAKED-CIPHERTEXT');
    expect(JSON.stringify(wire)).not.toContain('sealedValue');
  });

  it('renders dates as ISO strings and keeps rotatedAt nullable', () => {
    expect(credentialToV1(domain).rotatedAt).toBeNull();
    const rotated = credentialToV1({
      ...domain,
      version: 2,
      rotatedAt: new Date('2026-09-08T01:02:03.000Z'),
    });
    expect(rotated.rotatedAt).toBe('2026-09-08T01:02:03.000Z');
    expect(rotated.createdAt).toBe('2026-09-08T00:00:00.000Z');
    expect(rotated.version).toBe(2);
  });
});

describe('bumpCatalogAfterWrite', () => {
  it('bumps the catalog version', async () => {
    await bumpCatalogAfterWrite('cred-1');
    expect(mockBumpCatalogVersion).toHaveBeenCalledTimes(1);
  });

  it('logs and resolves when the bump fails — a committed write is not rolled back', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBumpCatalogVersion.mockRejectedValue(new Error('catalog state missing'));
    await expect(bumpCatalogAfterWrite('cred-1')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cred-1'), expect.any(Error));
    errorSpy.mockRestore();
  });
});
