/**
 * Tests for scripts/gen-router-keypair.ts (M2·T2.2).
 *
 * 这个脚本是运维拿到密钥的唯一入口，所以断言的是「拿到的东西是对的」：
 *   - 两段 PEM 各自完整、base64 形式能还原
 *   - keyId 与公钥一致（router 解封时按它比对）
 *   - 公钥段里不含私钥材料——复制粘贴时最容易出的事故
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { generateRouterKeyPair } from '@open-rush/llm-router';
import { describe, expect, it } from 'vitest';
import { renderRouterKeypair } from '../gen-router-keypair.ts';

const pair = generateRouterKeyPair();
const rendered = renderRouterKeypair(pair);

const envValue = (name: string): string => {
  const match = rendered.match(new RegExp(`^${name}=(.+)$`, 'm'));
  if (!match) throw new Error(`missing ${name} line`);
  return match[1];
};

describe('renderRouterKeypair', () => {
  it('emits both PEM blocks and the keyId', () => {
    expect(rendered).toContain(pair.publicKeyPem.trim());
    expect(rendered).toContain(pair.privateKeyPem.trim());
    expect(rendered).toContain(`keyId ${pair.keyId}`);
  });

  it('emits a base64 LLM_ROUTER_PUBLIC_KEY that decodes to the public PEM', () => {
    const decoded = Buffer.from(envValue('LLM_ROUTER_PUBLIC_KEY'), 'base64').toString('utf8');
    expect(decoded).toBe(pair.publicKeyPem);
    expect(createPublicKey(decoded).asymmetricKeyType).toBe('x25519');
  });

  it('emits a base64 LLM_ROUTER_PRIVATE_KEY that decodes to the private PEM', () => {
    const decoded = Buffer.from(envValue('LLM_ROUTER_PRIVATE_KEY'), 'base64').toString('utf8');
    expect(decoded).toBe(pair.privateKeyPem);
    expect(createPrivateKey(decoded).asymmetricKeyType).toBe('x25519');
  });

  it('keeps private key material out of the public-key section', () => {
    const privateSectionStart = rendered.indexOf('# 2) 私钥');
    expect(privateSectionStart).toBeGreaterThan(0);
    const publicSection = rendered.slice(0, privateSectionStart);
    expect(publicSection).not.toContain('BEGIN PRIVATE KEY');
    expect(publicSection).not.toContain(Buffer.from(pair.privateKeyPem, 'utf8').toString('base64'));
  });

  it('points operators at the FILE-based variable as the recommended path', () => {
    expect(rendered).toContain('LLM_ROUTER_PRIVATE_KEY_FILE=');
    expect(rendered).toMatch(/kubectl get deploy web control-worker/);
  });
});
