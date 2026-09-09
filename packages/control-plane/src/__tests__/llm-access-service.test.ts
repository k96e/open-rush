/**
 * LlmAccessService 单测（M6·T6.1）。
 *
 * 用内存 store——这一层要证的是「签发什么、怎么算过期、吊销幂等不幂等」，
 * 而不是 SQL。真库上的分支在 `drizzle-router-token-store.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTER_TOKEN_TTL_SECONDS, LlmAccessService } from '../llm/llm-access-service.js';
import type {
  CreateRouterTokenInput,
  RouterTokenStore,
  RunUsageTotals,
} from '../llm/router-token-store.js';

class MemoryTokenStore implements RouterTokenStore {
  created: CreateRouterTokenInput[] = [];
  revoked: string[] = [];
  usage: RunUsageTotals | null = null;
  failCreate = false;

  async create(input: CreateRouterTokenInput): Promise<{ id: string }> {
    if (this.failCreate) throw new Error('db down');
    this.created.push(input);
    return { id: `tok-${this.created.length}` };
  }

  async revokeByRunId(runId: string): Promise<number> {
    // 第一次吊销命中 1 行，之后都是 0——真实的 `WHERE revoked_at IS NULL` 语义。
    const first = !this.revoked.includes(runId);
    this.revoked.push(runId);
    return first ? 1 : 0;
  }

  async aggregateCallsByRun(_runId: string): Promise<RunUsageTotals | null> {
    return this.usage;
  }
}

const CTX = {
  runId: 'run-1',
  agentId: 'agent-1',
  projectId: 'proj-1',
  ownerUserId: 'user-1',
  modelAlias: 'sonnet',
};

let store: MemoryTokenStore;
let service: LlmAccessService;

beforeEach(() => {
  store = new MemoryTokenStore();
  service = new LlmAccessService(store, { routerBaseUrl: 'http://router:8790' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('issueForRun', () => {
  it('返回明文令牌，而库里只有它的 hash', async () => {
    const grant = await service.issueForRun(CTX);
    const plaintext = grant.env.ANTHROPIC_AUTH_TOKEN;

    expect(plaintext.startsWith('rt_')).toBe(true);
    expect(store.created).toHaveLength(1);
    const row = store.created[0];
    // 明文一个字节都不能进库。
    expect(row.tokenHash).not.toContain(plaintext);
    expect(JSON.stringify(row)).not.toContain(plaintext);
    // 存的确实是它的 SHA-256。
    expect(row.tokenHash).toBe(LlmAccessService.hashToken(plaintext));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('三个 env 变量齐全，且 alias 与入参一致', async () => {
    const grant = await service.issueForRun({ ...CTX, modelAlias: 'glm-4.7' });
    expect(grant.env.ANTHROPIC_BASE_URL).toBe('http://router:8790');
    expect(grant.env.ANTHROPIC_MODEL).toBe('glm-4.7');
    expect(Object.keys(grant.env).sort()).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
    ]);
    // 沙箱 env 里不能有任何 API_KEY 形态的键——那是 A11 的边界。
    expect(grant.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('归属整行写进去（D6：授权与计费只认这一行）', async () => {
    await service.issueForRun(CTX);
    expect(store.created[0]).toMatchObject({
      subjectType: 'run',
      runId: 'run-1',
      agentId: 'agent-1',
      projectId: 'proj-1',
      ownerUserId: 'user-1',
    });
  });

  it('最小权限：白名单里只有这次 run 要用的那一个 alias', async () => {
    await service.issueForRun({ ...CTX, modelAlias: 'opus' });
    expect(store.created[0].allowedModelAliases).toEqual(['opus']);
  });

  it('两次签发的明文不同（不是常量、不是可预测序列）', async () => {
    const a = await service.issueForRun(CTX);
    const b = await service.issueForRun(CTX);
    expect(a.env.ANTHROPIC_AUTH_TOKEN).not.toBe(b.env.ANTHROPIC_AUTH_TOKEN);
    expect(a.tokenId).not.toBe(b.tokenId);
  });

  describe('过期时间', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'));
    });

    it('缺省 = 沙箱 ttl 3600s + 5 分钟缓冲', async () => {
      await service.issueForRun(CTX);
      expect(store.created[0].expiresAt.toISOString()).toBe('2026-09-09T01:05:00.000Z');
      expect(DEFAULT_ROUTER_TOKEN_TTL_SECONDS).toBe(3900);
    });

    it('入参 ttl 优先于构造时的默认值', async () => {
      const svc = new LlmAccessService(store, {
        routerBaseUrl: 'http://router:8790',
        defaultTtlSeconds: 100,
      });
      await svc.issueForRun({ ...CTX, ttlSeconds: 60 });
      expect(store.created[0].expiresAt.toISOString()).toBe('2026-09-09T00:01:00.000Z');
    });

    it('构造时的默认值优先于全局缺省', async () => {
      const svc = new LlmAccessService(store, {
        routerBaseUrl: 'http://router:8790',
        defaultTtlSeconds: 100,
      });
      await svc.issueForRun(CTX);
      expect(store.created[0].expiresAt.toISOString()).toBe('2026-09-09T00:01:40.000Z');
    });
  });

  it('库写失败时抛出——签发不了就不该让 run 带着「以为有令牌」继续跑', async () => {
    store.failCreate = true;
    await expect(service.issueForRun(CTX)).rejects.toThrow('db down');
  });
});

describe('revokeForRun', () => {
  it('返回被吊销的行数', async () => {
    await service.issueForRun(CTX);
    expect(await service.revokeForRun('run-1')).toBe(1);
  });

  it('幂等：重复调用不抛，只是命中 0 行', async () => {
    await service.revokeForRun('run-1');
    expect(await service.revokeForRun('run-1')).toBe(0);
    expect(store.revoked).toEqual(['run-1', 'run-1']);
  });
});

describe('aggregateUsage', () => {
  it('有记录时原样透出', async () => {
    store.usage = { tokensIn: 120, tokensOut: 30, costUsd: 0.0042 };
    expect(await service.aggregateUsage('run-1')).toEqual({
      tokensIn: 120,
      tokensOut: 30,
      costUsd: 0.0042,
    });
  });

  it('无记录返回 null——「一次都没调」与「调了但是 0」要分得开', async () => {
    expect(await service.aggregateUsage('run-1')).toBeNull();
  });
});
