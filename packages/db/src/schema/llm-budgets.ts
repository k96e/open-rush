import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * 预算配置（F6/A6）。作用域解析优先级 `agent → project → user → global`，
 * 取最近的一档；`enforce = false` 即 observe 档——只计量不拦截。
 *
 * 唯一约束用 **NULLS NOT DISTINCT**：`subject_type = 'global'` 的行
 * `subject_id` 为 NULL，默认的 NULL-distinct 语义会让「全局 / day」预算
 * 可以被重复插入，PUT 的 upsert 也无法命中冲突目标。
 */
export const llmBudgets = pgTable(
  'llm_budgets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 'global' | 'project' | 'user' | 'agent' */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    /** global 时为 NULL */
    subjectId: uuid('subject_id'),
    /** 'day' | 'month' | 'total' */
    window: varchar('window', { length: 20 }).notNull(),
    limitUsd: numeric('limit_usd', { precision: 12, scale: 6 }).notNull(),
    /** false = observe（只计量不拦截，A6：「开关关闭时不卡业务但仍计量」）；true = enforce */
    enforce: boolean('enforce').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('llm_budgets_subject_window_idx')
      .on(t.subjectType, t.subjectId, t.window)
      .nullsNotDistinct(),
    // 本表与 llm_budget_usage 之间没有外键，只靠 (subject_type, window) 约定对齐。
    // 一个大小写或拼写差异就会生出一行永远撞不到限额、也永远不报错的影子累计器，
    // 所以两侧的 subject_type 都在 DB 里锁死到契约枚举。
    check(
      'llm_budgets_subject_type_check',
      sql`${t.subjectType} IN ('global','project','user','agent')`
    ),
    check('llm_budgets_window_check', sql`${t.window} IN ('day','month','total')`),
  ]
);

/**
 * 预算累计器。累计用
 * `INSERT … ON CONFLICT (subject_type, subject_id, window_key) DO UPDATE
 *  SET cost_usd = llm_budget_usage.cost_usd + EXCLUDED.cost_usd`，
 * 与 `llm_calls` 批写在**同一个事务**里，保证不重不漏。
 *
 * 这里用 **UNIQUE NULLS NOT DISTINCT 而不是复合主键**：PostgreSQL 的
 * PRIMARY KEY 隐含 NOT NULL，而 `subject_type = 'global'` 的行
 * `subject_id` 必须为 NULL（与 `llm_budgets` 和 v1 契约保持同一套语义）。
 * 唯一约束同样能作为 ON CONFLICT 的推断目标，累加语义不变。
 * 另配一个代理主键 `id`：其余 6 张 llm_* 表都有主键，而无主键表在逻辑复制下
 * 连 UPDATE 都做不了——一张只有 UPDATE 的累计器表尤其不该踩这个坑
 * （`subject_id` 可空，唯一索引也无法用 REPLICA IDENTITY USING INDEX 顶上）。
 *
 * ⚠️ 读取 global 行必须用 `isNull(subjectId)`：`eq(col, null)` 生成
 * `WHERE subject_id = NULL`，SQL 里恒不匹配。写侧的 ON CONFLICT 认 NULL、
 * 读侧的 `=` 不认，这是本表唯一的非对称之处。
 */
export const llmBudgetUsage = pgTable(
  'llm_budget_usage',
  {
    /** 代理主键——累加靠下面的唯一约束，不靠它。 */
    id: uuid('id').defaultRandom().primaryKey(),
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    subjectId: uuid('subject_id'),
    /** 'day' → '2026-09-08'；'month' → '2026-09'；'total' → 'total'（UTC） */
    windowKey: varchar('window_key', { length: 20 }).notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    calls: integer('calls').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('llm_budget_usage_subject_window_uniq')
      .on(t.subjectType, t.subjectId, t.windowKey)
      .nullsNotDistinct(),
    check(
      'llm_budget_usage_subject_type_check',
      sql`${t.subjectType} IN ('global','project','user','agent')`
    ),
  ]
);
