import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { llmProviders } from './llm-providers.js';

/**
 * 模型别名 ↔ 供应商目录（F1/F4 的核心）。
 *
 * A4 的判定规则（`resolveRoute(alias)`，M3 实现）：取 `enabled = true`
 * 且 `provider.enabled = true` 的行中 `priority` 最小者；并列时按 `id`
 * 升序保证确定性。无匹配 → 404，且错误信息只回显 alias，不回显目录内容。
 *
 * 价格列是 `numeric`——drizzle 把它映射成 **string** 而不是 number，
 * 写 store / computeCostUsd 时不要当数字用。
 */
export const llmModels = pgTable(
  'llm_models',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 上层看到的模型名。默认应与 upstreamModel 同名以获得字节级零改写（D2b） */
    alias: varchar('alias', { length: 255 }).notNull(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => llmProviders.id, { onDelete: 'cascade' }),
    /** 上游真实模型名 */
    upstreamModel: varchar('upstream_model', { length: 255 }).notNull(),
    /** 同 alias 多行时的优先级，取 enabled 中最小者。为未来 fallback chain 预留 */
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    /** /v1/models 模型发现用；Claude Code 只收 id 含 claude/anthropic 的条目 */
    displayName: varchar('display_name', { length: 255 }),
    maxOutputTokens: integer('max_output_tokens'),
    // ── 价格（USD / 每百万 token），用于 cost_usd 计算 ──
    priceInputPerMtok: numeric('price_input_per_mtok', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    priceOutputPerMtok: numeric('price_output_per_mtok', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    priceCacheWritePerMtok: numeric('price_cache_write_per_mtok', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    priceCacheReadPerMtok: numeric('price_cache_read_per_mtok', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    /** OpenAI 系的 reasoning_tokens 若单独计价则填；Anthropic 的 thinking 已含在 output 中，留 0 */
    priceReasoningPerMtok: numeric('price_reasoning_per_mtok', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('llm_models_alias_provider_idx').on(t.alias, t.providerId),
    index('llm_models_alias_enabled_idx').on(t.alias, t.enabled, t.priority),
  ]
);
