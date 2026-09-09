/**
 * DrizzleRouterTokenStore 单测（M6·T6.1），跑在 PGlite 上。
 *
 * 真库上才说得清的三条：
 *  ① 吊销用 `WHERE revoked_at IS NULL`——幂等，且不会把别的 run 的令牌一起带走；
 *  ② `revoked_at` 取 **DB 时间**，不取进程时间；
 *  ③ `SUM()` 的空结果是 NULL 而不是 0，「一次都没调」要返回 null。
 *
 * DDL 逐字对齐 `0012_llm_router.sql`，但**不建 run/agent/project 外键**——
 * 那几张表各有几十列，而级联行为已由 `packages/db` 的 migration.test.ts 覆盖。
 */
import { PGlite } from '@electric-sql/pglite';
import * as schema from '@open-rush/db';
import { llmCalls, llmRouterTokens } from '@open-rush/db';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleRouterTokenStore } from '../llm/drizzle-router-token-store.js';

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let pglite: PGlite;
let db: TestDb;
let store: DrizzleRouterTokenStore;

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const OWNER = '55555555-5555-4555-8555-555555555555';

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  store = new DrizzleRouterTokenStore(db as never);

  await db.execute(sql`
    CREATE TABLE llm_router_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL,
      subject_type VARCHAR(20) NOT NULL,
      run_id UUID,
      agent_id UUID,
      project_id UUID,
      owner_user_id UUID,
      allowed_model_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
      max_cost_usd NUMERIC(12, 6),
      max_requests_per_minute INTEGER,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT llm_router_tokens_subject_check
        CHECK ((subject_type = 'run' AND run_id IS NOT NULL) OR subject_type = 'service')
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX llm_router_tokens_hash_uniq ON llm_router_tokens (token_hash)`
  );

  await db.execute(sql`
    CREATE TABLE llm_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id VARCHAR(64),
      token_id UUID,
      subject_type VARCHAR(20) NOT NULL,
      run_id UUID,
      agent_id UUID,
      project_id UUID,
      owner_user_id UUID,
      cc_session_id VARCHAR(128),
      cc_agent_id VARCHAR(128),
      model_alias VARCHAR(255) NOT NULL,
      provider_id UUID,
      upstream_model VARCHAR(255),
      protocol VARCHAR(20) NOT NULL,
      mode VARCHAR(20) NOT NULL,
      stream BOOLEAN NOT NULL DEFAULT false,
      status VARCHAR(30) NOT NULL,
      http_status INTEGER,
      error_code VARCHAR(50),
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      cost_usd NUMERIC(12, 6) NOT NULL DEFAULT '0',
      ttfb_ms INTEGER,
      latency_ms INTEGER,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}, 30000);

afterAll(async () => {
  await pglite.close();
}, 30000);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE llm_calls, llm_router_tokens RESTART IDENTITY CASCADE`);
});

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

function tokenInput(runId: string, tokenHash: string) {
  return {
    tokenHash,
    subjectType: 'run' as const,
    runId,
    agentId: AGENT,
    projectId: PROJECT,
    ownerUserId: OWNER,
    allowedModelAliases: ['sonnet'],
    expiresAt: inHours(1),
  };
}

async function insertCall(runId: string, values: Record<string, unknown> = {}): Promise<void> {
  await db.insert(llmCalls).values({
    subjectType: 'run',
    runId,
    modelAlias: 'sonnet',
    protocol: 'anthropic',
    mode: 'passthrough',
    status: 'success',
    startedAt: new Date(),
    ...values,
  });
}

describe('create', () => {
  it('写入整行归属，返回新行 id', async () => {
    const { id } = await store.create(tokenInput(RUN_A, 'hash-a'));
    const [row] = await db.select().from(llmRouterTokens).where(eq(llmRouterTokens.id, id));
    expect(row).toMatchObject({
      tokenHash: 'hash-a',
      subjectType: 'run',
      runId: RUN_A,
      agentId: AGENT,
      projectId: PROJECT,
      ownerUserId: OWNER,
      revokedAt: null,
    });
    expect(row.allowedModelAliases).toEqual(['sonnet']);
  });

  it('同一个 hash 写两次被唯一索引挡住', async () => {
    await store.create(tokenInput(RUN_A, 'dup'));
    await expect(store.create(tokenInput(RUN_B, 'dup'))).rejects.toThrow();
  });

  it('subjectType=run 却没有 runId 被 CHECK 挡住', async () => {
    await expect(store.create({ ...tokenInput(RUN_A, 'no-run'), runId: null })).rejects.toThrow();
  });
});

describe('revokeByRunId', () => {
  it('吊销该 run 的全部令牌，返回行数', async () => {
    await store.create(tokenInput(RUN_A, 'a1'));
    await store.create(tokenInput(RUN_A, 'a2'));
    expect(await store.revokeByRunId(RUN_A)).toBe(2);

    const rows = await db.select().from(llmRouterTokens).where(eq(llmRouterTokens.runId, RUN_A));
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('不碰别的 run 的令牌', async () => {
    await store.create(tokenInput(RUN_A, 'a1'));
    await store.create(tokenInput(RUN_B, 'b1'));
    await store.revokeByRunId(RUN_A);

    const [other] = await db.select().from(llmRouterTokens).where(eq(llmRouterTokens.runId, RUN_B));
    expect(other.revokedAt).toBeNull();
  });

  it('幂等：第二次命中 0 行，且不覆盖第一次的 revoked_at', async () => {
    await store.create(tokenInput(RUN_A, 'a1'));
    await store.revokeByRunId(RUN_A);
    const [first] = await db.select().from(llmRouterTokens).where(eq(llmRouterTokens.runId, RUN_A));

    expect(await store.revokeByRunId(RUN_A)).toBe(0);
    const [second] = await db
      .select()
      .from(llmRouterTokens)
      .where(eq(llmRouterTokens.runId, RUN_A));
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
  });

  it('没有任何令牌的 run 返回 0，不抛', async () => {
    expect(await store.revokeByRunId(RUN_A)).toBe(0);
  });
});

describe('aggregateCallsByRun', () => {
  it('一次调用都没有 → null（不是全 0）', async () => {
    expect(await store.aggregateCallsByRun(RUN_A)).toBeNull();
  });

  it('tokensIn 含缓存写与缓存读——输入侧的总量', async () => {
    await insertCall(RUN_A, {
      tokensIn: 100,
      tokensCacheWrite: 20,
      tokensCacheRead: 300,
      tokensOut: 50,
      costUsd: '0.001234',
    });
    expect(await store.aggregateCallsByRun(RUN_A)).toEqual({
      tokensIn: 420,
      tokensOut: 50,
      costUsd: 0.001234,
    });
  });

  it('多条相加，且只算本 run 的', async () => {
    await insertCall(RUN_A, { tokensIn: 10, tokensOut: 1, costUsd: '0.100000' });
    await insertCall(RUN_A, { tokensIn: 20, tokensOut: 2, costUsd: '0.200000' });
    await insertCall(RUN_B, { tokensIn: 999, tokensOut: 999, costUsd: '9.999999' });

    expect(await store.aggregateCallsByRun(RUN_A)).toEqual({
      tokensIn: 30,
      tokensOut: 3,
      costUsd: 0.3,
    });
  });

  it('被拒的调用也算进条数——它们 token 数是 0，但「调过」这件事要有', async () => {
    await insertCall(RUN_A, { status: 'budget_exceeded', httpStatus: 429 });
    expect(await store.aggregateCallsByRun(RUN_A)).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
  });
});
