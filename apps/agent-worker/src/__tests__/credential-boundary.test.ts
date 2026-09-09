/**
 * A11 回归：**供应商真 key 到不了 Claude Code 子进程**（M6·T6.3）。
 *
 * 为什么要有这一组：`ai-sdk-provider-claude-code` 在 3.4.4 → 3.6.0 之间反转了
 * 子进程 env 的继承行为——3.4.4 是窄白名单（不含 `ANTHROPIC_*`），3.6.0+ 改成
 * 前缀继承，容器里任何 `ANTHROPIC_API_KEY` 会自动漏进子进程（`ref/R1` §2.8）。
 *
 * 所以 `server.ts` 用**显式 `undefined`** 抹除，而不是「不设置就没有」。
 * 这一组用例就是钉死那件事：**即使 `process.env` 里设了值**，传给 provider 的
 * `env` 里这些键也必须是 `undefined`。升级 provider 依赖时这是第一道闸门。
 */
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('ai', () => ({ streamText: vi.fn() }));
vi.mock('ai-sdk-provider-claude-code', () => ({ claudeCode: vi.fn(() => 'mock-model') }));
vi.mock('@hono/node-server', () => ({ serve: vi.fn() }));

import { streamText } from 'ai';
import { claudeCode } from 'ai-sdk-provider-claude-code';
import app from '../server.js';

/** 必须被抹除的键。改这张表 = 改 A11 的边界，要同步改 specs/llm-router.md。 */
const ERASED_KEYS = [
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
] as const;

function mockStream(): void {
  (streamText as Mock).mockReturnValue({
    toUIMessageStreamResponse: vi.fn(() => new Response('ok')),
    response: Promise.resolve({}),
  });
}

async function postPrompt(payload: Record<string, unknown>): Promise<Response> {
  return app.request('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** `claudeCode` 被 `vi.mock` 换掉了，但静态类型仍是 provider——转型前先过 unknown。 */
const claudeCodeMock = claudeCode as unknown as Mock;

function lastProviderOptions(): { env: Record<string, string | undefined> } {
  const call = claudeCodeMock.mock.calls.at(-1);
  return call?.[1] as { env: Record<string, string | undefined> };
}

function providerEnv(): Record<string, string | undefined> {
  return lastProviderOptions().env;
}

describe('密钥边界（A11）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream();
  });

  it('即使 process.env 里设了供应商密钥，传给 provider 的 env 里也是 undefined', async () => {
    for (const key of ERASED_KEYS) {
      vi.stubEnv(key, 'leaked-value');
    }
    await postPrompt({ prompt: 'hello' });

    const env = providerEnv();
    for (const key of ERASED_KEYS) {
      // `in` 而不是 `?? undefined`：键必须存在且值为 undefined——provider 是把
      // `env` 覆盖在自己的白名单之上的，键不存在等于「不覆盖」，就漏了。
      expect(key in env).toBe(true);
      expect(env[key]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain('leaked-value');
    vi.unstubAllEnvs();
  });

  it('请求 body 里的 env 也不能把密钥带进去（控制面下发的只该是令牌）', async () => {
    await postPrompt({
      prompt: 'hello',
      env: {
        ANTHROPIC_BASE_URL: 'http://router:8790',
        ANTHROPIC_AUTH_TOKEN: 'rt_token',
        ANTHROPIC_API_KEY: 'sk-ant-should-be-erased',
        AWS_SECRET_ACCESS_KEY: 'should-be-erased',
      },
    });

    const env = providerEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // 网关那两个照常透传——抹除只针对供应商密钥。
    expect(env.ANTHROPIC_BASE_URL).toBe('http://router:8790');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('rt_token');
  });

  it('process.env.ANTHROPIC_BASE_URL 不再被拷进 providerEnv（网关地址只认控制面下发的）', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://direct.example.com');
    await postPrompt({ prompt: 'hello', env: { ANTHROPIC_BASE_URL: 'http://router:8790' } });
    expect(providerEnv().ANTHROPIC_BASE_URL).toBe('http://router:8790');
    vi.unstubAllEnvs();
  });

  it('请求没带 env 时仍然传 env 对象——抹除键必须到达 provider', async () => {
    await postPrompt({ prompt: 'hello' });
    expect(lastProviderOptions()).toHaveProperty('env');
    for (const key of ERASED_KEYS) {
      expect(key in providerEnv()).toBe(true);
    }
  });
});
