/**
 * llm-router 数据层的**真实 PostgreSQL** 集成测试（M1 验收）。
 *
 * PGlite 证明不了的两件事在这里证：
 *  1. 全链 migration 能在**干净库**上重放（0012 含手写的种子 INSERT）
 *  2. `createNotificationListener` 的真实 LISTEN/NOTIFY 往返（D7 的热变更通道）
 *
 * 每次运行都新建一个临时库、结束时 DROP，不碰开发库。
 * 没有可用的 PostgreSQL（未设 DATABASE_URL）时整组跳过——
 * 本地跑 `pnpm db:up` 后即可执行 `pnpm --filter @open-rush/db test:integration`。
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNotificationListener } from '../client.js';
import { runMigrations } from '../migrate.js';
import { llmBudgetUsage, llmCatalogState } from '../schema/index.js';

const ADMIN_URL = process.env.DATABASE_URL;
const SCRATCH_DB = `rush_llm_router_it_${randomBytes(4).toString('hex')}`;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// describe.skipIf 仍会执行 describe 回调体（只是把用例标记为跳过），
// 所以这里不能对 ADMIN_URL 做非空断言——用一个永不连接的占位串兜底。
const PLACEHOLDER_URL = 'postgresql://placeholder:placeholder@127.0.0.1:1/postgres';

describe.skipIf(!ADMIN_URL)('llm-router migration + LISTEN/NOTIFY on real PostgreSQL', () => {
  const adminUrl = ADMIN_URL ?? PLACEHOLDER_URL;
  const scratchUrl = withDatabase(adminUrl, SCRATCH_DB);
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${SCRATCH_DB}"`);

    await runMigrations({ databaseUrl: scratchUrl });

    client = postgres(scratchUrl, { max: 2 });
    db = drizzle(client);
  }, 120000);

  afterAll(async () => {
    await client?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  }, 60000);

  it('creates all seven llm_* tables', async () => {
    const rows = await client<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'llm\\_%'
      ORDER BY tablename
    `;
    const tables = rows.map((r) => r.tablename);

    expect(tables).toEqual([
      'llm_budget_usage',
      'llm_budgets',
      'llm_calls',
      'llm_catalog_state',
      'llm_credentials',
      'llm_models',
      'llm_providers',
      'llm_router_tokens',
    ]);
  });

  it('seeds llm_catalog_state with a single row at version 0', async () => {
    const rows = await db.select().from(llmCatalogState);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].version).toBe(0);
  });

  it('accumulates llm_budget_usage on the global (NULL subject) row', async () => {
    const upsert = (costUsd: string) =>
      db
        .insert(llmBudgetUsage)
        .values({
          subjectType: 'global',
          subjectId: null,
          windowKey: 'total',
          costUsd,
          tokens: 10,
          calls: 1,
        })
        .onConflictDoUpdate({
          target: [llmBudgetUsage.subjectType, llmBudgetUsage.subjectId, llmBudgetUsage.windowKey],
          set: {
            costUsd: sql`${llmBudgetUsage.costUsd} + excluded.cost_usd`,
            tokens: sql`${llmBudgetUsage.tokens} + excluded.tokens`,
            calls: sql`${llmBudgetUsage.calls} + excluded.calls`,
            updatedAt: new Date(),
          },
        });

    await upsert('0.010000');
    await upsert('0.020000');

    const rows = await db.select().from(llmBudgetUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBe('0.030000');
    expect(rows[0].calls).toBe(2);
  });

  it('delivers a pg_notify payload to createNotificationListener', async () => {
    const listener = createNotificationListener(scratchUrl);
    const received: string[] = [];
    const firstPayload = new Promise<string>((resolvePayload) => {
      void listener.listen('llm_catalog', (payload) => {
        received.push(payload);
        resolvePayload(payload);
      });
    });

    // 与 bumpCatalogVersion（M3·T3.2）同样的两步：事务内 version++，提交后 NOTIFY。
    await new Promise((r) => setTimeout(r, 200));
    const [bumped] = await db
      .update(llmCatalogState)
      .set({ version: sql`${llmCatalogState.version} + 1`, updatedAt: new Date() })
      .returning({ version: llmCatalogState.version });
    await db.execute(sql`SELECT pg_notify('llm_catalog', ${String(bumped.version)})`);

    await expect(firstPayload).resolves.toBe(String(bumped.version));
    expect(received).toEqual([String(bumped.version)]);

    await listener.close();
    await expect(listener.close()).resolves.toBeUndefined();
  }, 30000);
});
