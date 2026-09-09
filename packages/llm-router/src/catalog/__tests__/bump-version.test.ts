/**
 * bumpCatalogVersion 单测（M2·T2.3 依赖，正式归属 M3·T3.2）。
 *
 * 这个函数是「目录热变更」的唯一发条：忘了调，副本永远看不到新凭据/新模型。
 * 所以断言三件事——版本单调 +1、只动 id=1 那一行、NOTIFY 带上新版本号。
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmCatalogState } from '@open-rush/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import {
  bumpCatalogVersion,
  CatalogStateMissingError,
  LLM_CATALOG_CHANNEL,
} from '../bump-version.js';

let db: TestDb;
let pglite: PGlite;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

async function readVersion(): Promise<number> {
  const [row] = await db
    .select({ version: llmCatalogState.version })
    .from(llmCatalogState)
    .where(eq(llmCatalogState.id, 1));
  return row.version;
}

describe('bumpCatalogVersion', () => {
  it('increments the version bit and returns the new value', async () => {
    expect(await readVersion()).toBe(0);
    expect(await bumpCatalogVersion(db as never)).toBe(1);
    expect(await readVersion()).toBe(1);
  });

  it('is monotonic across repeated calls', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) seen.push(await bumpCatalogVersion(db as never));
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(await readVersion()).toBe(5);
  });

  it('touches updated_at so operators can see when the catalog last moved', async () => {
    await db.execute(
      sql`UPDATE llm_catalog_state SET updated_at = '2020-01-01T00:00:00Z' WHERE id = 1`
    );
    await bumpCatalogVersion(db as never);
    const [row] = await db.select().from(llmCatalogState).where(eq(llmCatalogState.id, 1));
    expect(row.updatedAt.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('emits pg_notify on the llm_catalog channel carrying the new version', async () => {
    const received: string[] = [];
    await pglite.listen(LLM_CATALOG_CHANNEL, (payload) => {
      received.push(payload);
    });

    const version = await bumpCatalogVersion(db as never);
    // PGlite 的 notify 投递是异步的，让出一轮事件循环再断言。
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toContain(String(version));
  });

  it('throws CatalogStateMissingError when the seed row is absent', async () => {
    await db.execute(sql`DELETE FROM llm_catalog_state`);
    await expect(bumpCatalogVersion(db as never)).rejects.toBeInstanceOf(CatalogStateMissingError);
  });

  it('never creates a second version row (the singleton CHECK holds)', async () => {
    await bumpCatalogVersion(db as never);
    const rows = await db.select().from(llmCatalogState);
    expect(rows).toHaveLength(1);
    await expect(
      db.execute(sql`INSERT INTO llm_catalog_state (id, version) VALUES (2, 0)`)
    ).rejects.toThrow();
  });
});
