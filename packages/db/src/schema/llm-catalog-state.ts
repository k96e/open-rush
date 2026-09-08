import { bigint, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

/**
 * 单行表（id 恒为 1），目录热变更的版本位（D7/A7/A8）。
 *
 * 任何目录/凭据写操作都必须：
 *   1) 在同一事务内 `UPDATE llm_catalog_state SET version = version + 1`
 *   2) **提交后**再 `pg_notify('llm_catalog', version::text)`
 * 副本收到 NOTIFY 立即刷新；同时以 LLM_CATALOG_POLL_MS（默认 5000）轮询本表兜底。
 *
 * 种子行由 migration 末尾的
 * `INSERT INTO "llm_catalog_state" ("id","version") VALUES (1,0) ON CONFLICT DO NOTHING`
 * 写入——drizzle 不会替我们生成它。
 */
export const llmCatalogState = pgTable('llm_catalog_state', {
  id: integer('id').primaryKey().default(1),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
