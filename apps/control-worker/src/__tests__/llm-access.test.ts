/**
 * llm-router 装配的两条路径（M6·T6.4）。
 *
 * `LLM_ROUTER_BASE_URL` 在与不在，决定 `RunOrchestrator` 走网关还是退化为
 * 改造前行为。这是灰度与回滚开关，所以两条路径都要有用例——尤其是「不在」那条
 * 必须**打一条 warn**：静默不装配会让人以为接上了，dev 下的表现是「Claude Code
 * 还在直连供应商」，只有看日志才分得出来。
 */
import type { CreateRouterTokenInput, RouterTokenStore } from '@open-rush/control-plane';
import type { DbClient } from '@open-rush/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLlmAccess, type LlmAccessEnv, type LlmAccessLogger } from '../llm-access.js';

/** 真 store 构造时不碰 db，这里给个占位就够。 */
const FAKE_DB = {} as DbClient;

const ISSUE_CTX = {
  runId: 'run-1',
  agentId: 'agent-1',
  projectId: 'proj-1',
  ownerUserId: null,
  modelAlias: 'sonnet',
};

class CapturingStore implements RouterTokenStore {
  created: CreateRouterTokenInput[] = [];
  async create(input: CreateRouterTokenInput): Promise<{ id: string }> {
    this.created.push(input);
    return { id: 'tok-1' };
  }
  async revokeByRunId(): Promise<number> {
    return 0;
  }
  async aggregateCallsByRun(): Promise<null> {
    return null;
  }
}

let warns: string[];
let infos: string[];
let logger: LlmAccessLogger;
let store: CapturingStore;

/** 过期时间用假时钟断言：真时钟下 `Date.now()` 会在断言之间走，边界随机翻红。 */
const NOW = new Date('2026-09-09T00:00:00.000Z');

beforeEach(() => {
  warns = [];
  infos = [];
  logger = { warn: (m) => warns.push(m), info: (m) => infos.push(m) };
  store = new CapturingStore();
});

afterEach(() => {
  vi.useRealTimers();
});

const build = (env: LlmAccessEnv) => createLlmAccess(FAKE_DB, env, logger, () => store);

describe('createLlmAccess', () => {
  it('LLM_ROUTER_BASE_URL 存在 → 装配，并打一条 info', () => {
    expect(build({ LLM_ROUTER_BASE_URL: 'http://router:8790' })).toBeDefined();
    expect(infos.some((m) => m.includes('http://router:8790'))).toBe(true);
    expect(warns).toHaveLength(0);
  });

  it('签发出来的 env 指向配置的网关地址', async () => {
    const grant = await build({ LLM_ROUTER_BASE_URL: 'http://router:8790' })?.issueForRun(
      ISSUE_CTX
    );
    expect(grant?.env.ANTHROPIC_BASE_URL).toBe('http://router:8790');
  });

  it.each([
    ['未设置', undefined],
    ['空串', ''],
    ['全空白', '   '],
  ])('LLM_ROUTER_BASE_URL %s → 不装配，并打一条 warn', (_name, raw) => {
    expect(build({ LLM_ROUTER_BASE_URL: raw })).toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('LLM_ROUTER_BASE_URL');
    expect(infos).toHaveLength(0);
  });

  it('地址两端的空白被去掉——尾随空格会让每次转发都打到错的 URL', async () => {
    const grant = await build({ LLM_ROUTER_BASE_URL: '  http://router:8790  ' })?.issueForRun(
      ISSUE_CTX
    );
    expect(grant?.env.ANTHROPIC_BASE_URL).toBe('http://router:8790');
  });

  it.each([
    ['非数字', 'abc'],
    ['零', '0'],
    ['负数', '-1'],
    ['未设置', undefined],
  ])('TTL %s → 回落到缺省 3900s', async (_name, raw) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await build({
      LLM_ROUTER_BASE_URL: 'http://router:8790',
      LLM_ROUTER_TOKEN_TTL_SECONDS: raw,
    })?.issueForRun(ISSUE_CTX);

    expect(store.created[0].expiresAt.toISOString()).toBe('2026-09-09T01:05:00.000Z');
  });

  it('合法 TTL 生效', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await build({
      LLM_ROUTER_BASE_URL: 'http://router:8790',
      LLM_ROUTER_TOKEN_TTL_SECONDS: '60',
    })?.issueForRun(ISSUE_CTX);

    expect(store.created[0].expiresAt.toISOString()).toBe('2026-09-09T00:01:00.000Z');
  });
});
