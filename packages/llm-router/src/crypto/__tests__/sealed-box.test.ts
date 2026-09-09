/**
 * sealed-box 单测（M2·T2.1）。
 *
 * 覆盖 A11 的密码学前提：web 拿到公钥能封、拿不到私钥就解不开，
 * 且任何一处被篡改都会失败而不是静默返回错误明文。
 */
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeKeyId,
  generateRouterKeyPair,
  openSealed,
  SEALED_BOX_ALG,
  seal,
} from '../sealed-box.js';

const pair = generateRouterKeyPair();
const other = generateRouterKeyPair();

/** 把 base64 密文解成 Buffer，改一个字节再编回去。 */
function tamperByte(value: string, index: number): string {
  const buf = Buffer.from(value, 'base64');
  buf[index] = buf[index] ^ 0xff;
  return buf.toString('base64');
}

describe('seal / openSealed', () => {
  it('1. round-trips ASCII, UTF-8 and an 8KB key', () => {
    const cases = [
      'sk-ant-api03-abcdefghijklmnop',
      '密钥-with-中文-and-emoji-🔑',
      'k'.repeat(8192),
    ];
    for (const plaintext of cases) {
      const env = seal(pair.publicKeyPem, plaintext);
      expect(env.alg).toBe(SEALED_BOX_ALG);
      expect(env.keyId).toBe(pair.keyId);
      expect(openSealed(pair.privateKeyPem, env)).toBe(plaintext);
    }
  });

  it('2. rejects a different recipient private key', () => {
    const env = seal(pair.publicKeyPem, 'sk-ant-secret-value');
    // keyId 先挡一道；把 keyId 也换成 other 的才能走到 GCM 校验。
    expect(() => openSealed(other.privateKeyPem, env)).toThrow(/keyId mismatch/);
    expect(() => openSealed(other.privateKeyPem, { ...env, keyId: other.keyId })).toThrow();
  });

  it('3. rejects a ciphertext with any tampered byte (GCM tag)', () => {
    const env = seal(pair.publicKeyPem, 'sk-ant-secret-value');
    // 依次破坏 ephPub / iv / tag / ciphertext 四段，每段都必须炸。
    for (const index of [0, 33, 45, 61]) {
      const tampered = { ...env, value: tamperByte(env.value, index) };
      expect(() => openSealed(pair.privateKeyPem, tampered)).toThrow();
    }
  });

  it('4. rejects a mismatched keyId without touching the ciphertext', () => {
    const env = seal(pair.publicKeyPem, 'sk-ant-secret-value');
    const forged = { ...env, keyId: other.keyId };
    expect(() => openSealed(pair.privateKeyPem, forged)).toThrow(/keyId mismatch/);
  });

  it('5. rejects an unsupported alg', () => {
    const env = seal(pair.publicKeyPem, 'sk-ant-secret-value');
    expect(() => openSealed(pair.privateKeyPem, { ...env, alg: 'aes-256-gcm' })).toThrow(
      /unsupported alg/
    );
  });

  it('6. produces a different ciphertext for the same plaintext each time', () => {
    const a = seal(pair.publicKeyPem, 'sk-ant-secret-value');
    const b = seal(pair.publicKeyPem, 'sk-ant-secret-value');
    expect(a.value).not.toBe(b.value);
    // 两份都能解回同一明文——差异只来自一次性临时密钥，不是坏密文。
    expect(openSealed(pair.privateKeyPem, a)).toBe('sk-ant-secret-value');
    expect(openSealed(pair.privateKeyPem, b)).toBe('sk-ant-secret-value');
  });

  it('7. rejects a truncated envelope (<= 60 header bytes)', () => {
    const env = seal(pair.publicKeyPem, 'sk-ant-secret-value');
    const truncated = Buffer.from(env.value, 'base64').subarray(0, 59).toString('base64');
    expect(() => openSealed(pair.privateKeyPem, { ...env, value: truncated })).toThrow(/malformed/);
    // 恰好 60 字节 = 头部齐了但密文为空，同样不是合法密钥。
    const empty = Buffer.from(env.value, 'base64').subarray(0, 60).toString('base64');
    expect(() => openSealed(pair.privateKeyPem, { ...env, value: empty })).toThrow(/malformed/);
  });

  it('8. generateRouterKeyPair().keyId equals computeKeyId(publicKey)', () => {
    expect(computeKeyId(createPublicKey(pair.publicKeyPem))).toBe(pair.keyId);
    expect(pair.keyId).toMatch(/^[0-9a-f]{32}$/);
    // 私钥推导出的公钥指纹也必须一致——这是 openSealed 的比对依据。
    expect(computeKeyId(createPublicKey(pair.privateKeyPem))).toBe(pair.keyId);
    expect(pair.keyId).not.toBe(other.keyId);
  });

  it('9. never leaks the plaintext into the envelope', () => {
    const plaintext = 'sk-ant-api03-NEVER-APPEARS-VERBATIM';
    const env = seal(pair.publicKeyPem, plaintext);
    expect(JSON.stringify(env)).not.toContain(plaintext);
    expect(Buffer.from(env.value, 'base64').toString('utf8')).not.toContain(plaintext);
  });

  it('10. seal() accepts a raw generated public key (not just our PEM)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const env = seal(pem, 'sk-generated-elsewhere');
    expect(openSealed(privPem, env)).toBe('sk-generated-elsewhere');
  });
});
