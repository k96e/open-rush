/**
 * 批写落库（M5·T5.1，PGlite）。
 *
 * 这里是整个 M5 唯一必须打真库的地方——要证的三件事都只在真 SQL 上成立：
 *  ① `llm_calls` 与 `llm_budget_usage` 在**同一个事务**里，一起成或一起败；
 *  ② `ON CONFLICT DO UPDATE` 的累加对 `subject_id IS NULL`（global 档）同样命中
 *    （靠 UNIQUE **NULLS NOT DISTINCT**）；
 *  ③ numeric 的累加不掉精度。
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmBudgetUsage, llmCalls } from '@open-rush/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCallRecord } from '../../../test/call-records.js';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import { DrizzleCallStore } from '../drizzle-call-store.js';

let db: TestDb;
let pglite: PGlite;
let store: DrizzleCallStore;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
  store = new DrizzleCallStore(db as never);
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

const globalUsage = (windowKey: string) =>
  db
    .select()
    .from(llmBudgetUsage)
    .where(
      and(
        eq(llmBudgetUsage.subjectType, 'global'),
        isNull(llmBudgetUsage.subjectId),
        eq(llmBudgetUsage.windowKey, windowKey)
      )
    );

describe('DrizzleCallStore.insertBatchWithBudget', () => {
  it('空批不打库', async () => {
    await store.insertBatchWithBudget([]);
    expect(await db.select().from(llmCalls)).toHaveLength(0);
  });

  it('明细的每一列都原样落库', async () => {
    await store.insertBatchWithBudget([
      makeCallRecord({
        requestId: 'req-x',
        projectId: '11111111-1111-1111-1111-111111111111',
        ccSessionId: 'cc-session',
        ccAgentId: 'cc-agent',
        modelAlias: 'gpt-5-mini',
        upstreamModel: 'gpt-5-mini-2026',
        protocol: 'openai',
        mode: 'rewrite-model',
        stream: true,
        status: 'success',
        httpStatus: 200,
        tokensIn: 11,
        tokensCacheWrite: 22,
        tokensCacheRead: 33,
        tokensOut: 44,
        tokensReasoning: 5,
        costUsd: '0.123456',
        ttfbMs: 90,
        latencyMs: 1234,
      }),
    ]);

    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({
      requestId: 'req-x',
      subjectType: 'run',
      projectId: '11111111-1111-1111-1111-111111111111',
      ccSessionId: 'cc-session',
      modelAlias: 'gpt-5-mini',
      protocol: 'openai',
      mode: 'rewrite-model',
      stream: true,
      status: 'success',
      httpStatus: 200,
      tokensIn: 11,
      tokensCacheWrite: 22,
      tokensCacheRead: 33,
      tokensOut: 44,
      tokensReasoning: 5,
      costUsd: '0.123456',
      ttfbMs: 90,
      latencyMs: 1234,
    });
  });

  it('★ 一条调用同时累加 day / month / total 三个 global 桶', async () => {
    await store.insertBatchWithBudget([makeCallRecord({ costUsd: '0.001050' })]);

    for (const key of ['2026-09-08', '2026-09', 'total']) {
      const [row] = await globalUsage(key);
      expect(row, key).toMatchObject({ costUsd: '0.001050', tokens: 150, calls: 1 });
    }
  });

  it('★ 两批之间累加（ON CONFLICT DO UPDATE 命中 NULL 的 subject_id）', async () => {
    await store.insertBatchWithBudget([makeCallRecord({ costUsd: '0.000001' })]);
    await store.insertBatchWithBudget([makeCallRecord({ costUsd: '0.000002' })]);

    const [row] = await globalUsage('total');
    expect(row).toMatchObject({ costUsd: '0.000003', calls: 2, tokens: 300 });
    expect(await db.select().from(llmCalls)).toHaveLength(2);
  });

  it('★ numeric 累加不掉精度：0.1 写十次正好 1.000000', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insertBatchWithBudget([makeCallRecord({ costUsd: '0.100000' })]);
    }
    const [row] = await globalUsage('total');
    expect(row.costUsd).toBe('1.000000');
    expect(row.calls).toBe(10);
  });

  it('批内同桶去重：100 条同项目的调用只写一行累计器', async () => {
    const batch = Array.from({ length: 100 }, () =>
      makeCallRecord({ projectId: '22222222-2222-2222-2222-222222222222', costUsd: '0.000010' })
    );
    await store.insertBatchWithBudget(batch);

    const projectRows = await db
      .select()
      .from(llmBudgetUsage)
      .where(eq(llmBudgetUsage.subjectType, 'project'));
    expect(projectRows).toHaveLength(3); // day / month / total
    expect(projectRows.every((r) => r.calls === 100)).toBe(true);
    expect(projectRows.every((r) => r.costUsd === '0.001000')).toBe(true);
    expect(await db.select().from(llmCalls)).toHaveLength(100);
  });

  it('四档归属齐全 → 12 行累计器', async () => {
    await store.insertBatchWithBudget([
      makeCallRecord({
        projectId: '22222222-2222-2222-2222-222222222222',
        ownerUserId: '33333333-3333-3333-3333-333333333333',
        agentId: '44444444-4444-4444-4444-444444444444',
      }),
    ]);
    expect(await db.select().from(llmBudgetUsage)).toHaveLength(12);
  });

  it('★ 事务原子性：明细违约（模型别名超长）时累计器一行都不写', async () => {
    await expect(
      store.insertBatchWithBudget([makeCallRecord({ modelAlias: 'x'.repeat(300) })])
    ).rejects.toThrow();

    expect(await db.select().from(llmCalls)).toHaveLength(0);
    expect(await db.select().from(llmBudgetUsage)).toHaveLength(0);
  });

  it('★ 事务原子性：第二条违约时，同批第一条的明细与累计器一起回滚', async () => {
    await expect(
      store.insertBatchWithBudget([
        makeCallRecord(),
        makeCallRecord({ status: 'x'.repeat(50) as never }),
      ])
    ).rejects.toThrow();

    expect(await db.select().from(llmCalls)).toHaveLength(0);
    expect(await db.select().from(llmBudgetUsage)).toHaveLength(0);
  });

  it('拒绝路径的记录（0 花费）也进账，calls 照样 +1', async () => {
    await store.insertBatchWithBudget([
      makeCallRecord({
        status: 'model_not_found',
        httpStatus: 404,
        errorCode: 'MODEL_NOT_FOUND',
        modelAlias: '',
        tokensIn: 0,
        tokensCacheWrite: 0,
        tokensCacheRead: 0,
        tokensOut: 0,
        costUsd: '0.000000',
      }),
    ]);
    const [row] = await globalUsage('total');
    expect(row).toMatchObject({ costUsd: '0.000000', tokens: 0, calls: 1 });
  });
});
