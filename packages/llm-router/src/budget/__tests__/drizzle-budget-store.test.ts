/**
 * 预算读取（M5·T5.2，PGlite）。
 *
 * 这里唯一非跑真库不可的点：**global 那一档的 `subject_id` 是 NULL**。
 * drizzle 的 `eq(col, null)` 生成 `WHERE subject_id = NULL`，SQL 里恒不匹配——
 * 只有真库能证明 `isNull` 那条分支写对了。
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmBudgets, llmBudgetUsage } from '@open-rush/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import { DrizzleBudgetStore } from '../drizzle-budget-store.js';

const PROJECT = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

let db: TestDb;
let pglite: PGlite;
let store: DrizzleBudgetStore;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
  store = new DrizzleBudgetStore(db as never);
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

describe('DrizzleBudgetStore.findBudgets', () => {
  it('候选为空时不打库', async () => {
    expect(await store.findBudgets([])).toEqual([]);
  });

  it('★ global 档（subject_id 为 NULL）能被查出来', async () => {
    await db
      .insert(llmBudgets)
      .values({ subjectType: 'global', subjectId: null, window: 'day', limitUsd: '10.000000' });

    expect(await store.findBudgets([{ subjectType: 'global', subjectId: null }])).toEqual([
      {
        subjectType: 'global',
        subjectId: null,
        window: 'day',
        limitUsd: '10.000000',
        enforce: false,
      },
    ]);
  });

  it('一次查回多个候选作用域的全部窗口行', async () => {
    await db.insert(llmBudgets).values([
      { subjectType: 'project', subjectId: PROJECT, window: 'day', limitUsd: '1.000000' },
      {
        subjectType: 'project',
        subjectId: PROJECT,
        window: 'month',
        limitUsd: '20.000000',
        enforce: true,
      },
      { subjectType: 'global', subjectId: null, window: 'total', limitUsd: '99.000000' },
    ]);

    const rows = await store.findBudgets([
      { subjectType: 'project', subjectId: PROJECT },
      { subjectType: 'global', subjectId: null },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.window === 'month')).toMatchObject({ enforce: true });
  });

  it('不在候选里的作用域不会被带出来', async () => {
    await db
      .insert(llmBudgets)
      .values({ subjectType: 'user', subjectId: USER, window: 'day', limitUsd: '1.000000' });

    expect(await store.findBudgets([{ subjectType: 'project', subjectId: PROJECT }])).toEqual([]);
  });

  it('同名 id 但类型不同不会串档', async () => {
    await db
      .insert(llmBudgets)
      .values({ subjectType: 'user', subjectId: PROJECT, window: 'day', limitUsd: '1.000000' });

    expect(await store.findBudgets([{ subjectType: 'project', subjectId: PROJECT }])).toEqual([]);
  });
});

describe('DrizzleBudgetStore.findUsage', () => {
  it('窗口键为空时不打库', async () => {
    expect(await store.findUsage({ subjectType: 'global', subjectId: null }, [])).toEqual({});
  });

  it('★ global 档的累计值（subject_id 为 NULL）能被查出来', async () => {
    await db.insert(llmBudgetUsage).values({
      subjectType: 'global',
      subjectId: null,
      windowKey: '2026-09-08',
      costUsd: '3.500000',
    });

    expect(
      await store.findUsage({ subjectType: 'global', subjectId: null }, ['2026-09-08', 'total'])
    ).toEqual({ '2026-09-08': '3.500000' });
  });

  it('只回本作用域的行', async () => {
    await db.insert(llmBudgetUsage).values([
      { subjectType: 'project', subjectId: PROJECT, windowKey: 'total', costUsd: '1.000000' },
      { subjectType: 'user', subjectId: USER, windowKey: 'total', costUsd: '2.000000' },
    ]);

    expect(
      await store.findUsage({ subjectType: 'project', subjectId: PROJECT }, ['total'])
    ).toEqual({ total: '1.000000' });
  });

  it('缺行就是缺键——由 BudgetService 按 0 处理', async () => {
    expect(
      await store.findUsage({ subjectType: 'project', subjectId: PROJECT }, ['2026-09-08'])
    ).toEqual({});
  });
});
