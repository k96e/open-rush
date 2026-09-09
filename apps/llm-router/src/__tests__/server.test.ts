/**
 * 启动期的 fail-fast（M4·T4.1）。
 *
 * 只测 `main()` 在私钥缺失/非法时**不肯起来**这一条——这是 C7 §7.14 的第一条
 * 设计意图：带着「能转发但不能解封」的半残状态跑起来，会让每一次真实调用都在
 * 上游认证处才炸，比起不来难查得多。
 */

import { generateRouterKeyPair } from '@open-rush/llm-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../server.js';

const KEYS = ['LLM_ROUTER_PRIVATE_KEY', 'LLM_ROUTER_PRIVATE_KEY_FILE', 'DATABASE_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('main()', () => {
  it('★ 两个私钥环境变量都没配 → 抛错（入口据此 exit(1)）', async () => {
    await expect(main()).rejects.toThrow(/PRIVATE_KEY/);
  });

  it('私钥不是合法 PEM → 抛错', async () => {
    process.env.LLM_ROUTER_PRIVATE_KEY = 'not-a-pem';
    await expect(main()).rejects.toThrow();
  });

  it('私钥算法不是 X25519 → 抛错', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.LLM_ROUTER_PRIVATE_KEY = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    await expect(main()).rejects.toThrow(/X25519/);
  });

  it('私钥合法但 DATABASE_URL 缺失 → 仍然抛错（密钥检查在前，DB 在后）', async () => {
    process.env.LLM_ROUTER_PRIVATE_KEY = generateRouterKeyPair().privateKeyPem;
    await expect(main()).rejects.toThrow(/DATABASE_URL/);
  });
});
