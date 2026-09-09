/**
 * key-loader 单测（M2·T2.2）。
 *
 * 关注点是 fail-fast：任何一种「装不上私钥」的情况都必须抛，不能返回一个
 * 看起来能用、实际解不开信封的半成品。
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadRouterPrivateKey } from '../key-loader.js';
import { generateRouterKeyPair } from '../sealed-box.js';

const dir = mkdtempSync(join(tmpdir(), 'llm-router-key-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pair = generateRouterKeyPair();
const otherPair = generateRouterKeyPair();

function writeKeyFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('loadRouterPrivateKey', () => {
  it('loads from LLM_ROUTER_PRIVATE_KEY_FILE and derives the keyId', () => {
    const path = writeKeyFile('router.pem', pair.privateKeyPem);
    const loaded = loadRouterPrivateKey({ LLM_ROUTER_PRIVATE_KEY_FILE: path });
    expect(loaded.keyId).toBe(pair.keyId);
    expect(loaded.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('prefers FILE over the inline variable when both are set', () => {
    const path = writeKeyFile('preferred.pem', pair.privateKeyPem);
    const loaded = loadRouterPrivateKey({
      LLM_ROUTER_PRIVATE_KEY_FILE: path,
      LLM_ROUTER_PRIVATE_KEY: otherPair.privateKeyPem,
    });
    expect(loaded.keyId).toBe(pair.keyId);
  });

  it('does NOT silently fall back to inline when the FILE is unreadable', () => {
    expect(() =>
      loadRouterPrivateKey({
        LLM_ROUTER_PRIVATE_KEY_FILE: join(dir, 'does-not-exist.pem'),
        LLM_ROUTER_PRIVATE_KEY: pair.privateKeyPem,
      })
    ).toThrow(/ENOENT/);
  });

  it('loads an inline PEM', () => {
    const loaded = loadRouterPrivateKey({ LLM_ROUTER_PRIVATE_KEY: pair.privateKeyPem });
    expect(loaded.keyId).toBe(pair.keyId);
  });

  it('loads an inline base64-wrapped PEM', () => {
    const b64 = Buffer.from(pair.privateKeyPem, 'utf8').toString('base64');
    expect(b64).not.toContain('BEGIN');
    const loaded = loadRouterPrivateKey({ LLM_ROUTER_PRIVATE_KEY: b64 });
    expect(loaded.keyId).toBe(pair.keyId);
  });

  it('throws with a generation hint when neither variable is set', () => {
    expect(() => loadRouterPrivateKey({})).toThrow(/neither LLM_ROUTER_PRIVATE_KEY_FILE/);
    // 空白串等同于未设置。
    expect(() =>
      loadRouterPrivateKey({ LLM_ROUTER_PRIVATE_KEY: '   ', LLM_ROUTER_PRIVATE_KEY_FILE: '  ' })
    ).toThrow(/neither LLM_ROUTER_PRIVATE_KEY_FILE/);
  });

  it('throws on a non-X25519 private key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => loadRouterPrivateKey({ LLM_ROUTER_PRIVATE_KEY: pem })).toThrow(
      /expected an X25519 private key, got ed25519/
    );
  });

  it('throws on malformed PEM content', () => {
    expect(() =>
      loadRouterPrivateKey({ LLM_ROUTER_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' })
    ).toThrow();
  });
});
