/**
 * 目录版本位 bump（D7 / A7 / A8）。
 *
 * `llm_catalog_state` 是单行表（id 恒为 1）。**每一个** 目录/凭据写操作
 * （POST / PATCH / DELETE / rotate）都必须在写成功后调用本函数，否则副本永远
 * 看不到变更——这是 `00-必读.md` §五③ 点名的坑。
 *
 * 两步顺序不可颠倒：
 *   1. `UPDATE … SET version = version + 1 WHERE id = 1`
 *   2. **提交后**再 `pg_notify('llm_catalog', <version>)`
 * 若在事务内 NOTIFY，监听方可能在写事务提交前就来刷新，读到旧数据。所以本
 * 函数**不要**放进调用方的事务里跑。
 *
 * 注：`llm_catalog_state_singleton` CHECK 约束保证只会有 id=1 一行，
 * 因此 `WHERE id = 1` 永远命中那唯一的版本位。
 */
import { type DbClient, llmCatalogState } from '@open-rush/db';
import { eq, sql } from 'drizzle-orm';

/** 种子行缺失时抛这个——比让调用方拿到 `undefined.version` 好定位。 */
export class CatalogStateMissingError extends Error {
  constructor() {
    super(
      'llm_catalog_state row (id=1) is missing; the 0012_llm_router migration seeds it. ' +
        'Run pnpm db:push / the migration before serving catalog writes.'
    );
    this.name = 'CatalogStateMissingError';
  }
}

export const LLM_CATALOG_CHANNEL = 'llm_catalog';

/** 返回 bump 之后的新版本号。 */
export async function bumpCatalogVersion(db: DbClient): Promise<number> {
  const [row] = await db
    .update(llmCatalogState)
    .set({ version: sql`${llmCatalogState.version} + 1`, updatedAt: new Date() })
    .where(eq(llmCatalogState.id, 1))
    .returning({ version: llmCatalogState.version });

  if (!row) throw new CatalogStateMissingError();

  // NOTIFY 在 UPDATE 提交之后发出（本函数不开事务，上一句已自动提交）。
  await db.execute(sql`SELECT pg_notify(${LLM_CATALOG_CHANNEL}, ${String(row.version)})`);
  return row.version;
}
