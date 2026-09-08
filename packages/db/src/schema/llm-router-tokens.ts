import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { projects } from './projects.js';
import { runs } from './runs.js';
import { users } from './users.js';

/**
 * llm-router 的调用方凭据。与 `service_tokens` 的区别（D5）：
 *  - subject 是 run/agent/project 而非 user；`owner_user_id` 可空
 *  - 生命周期是分钟级（随 run 创建、随 run 收敛吊销）
 *  - 带配额字段（maxCostUsd / maxRequestsPerMinute），service_tokens 没有
 * 复用的是范式：明文只在创建时返回一次，库里只存 SHA-256 hex。
 *
 * D6「令牌即归属」：授权与计费只认本表的 run/agent/project/owner 字段，
 * `x-claude-code-*` 头只作分组提示。
 */
export const llmRouterTokens = pgTable(
  'llm_router_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** SHA-256(明文) hex，明文形如 rt_<43 chars base64url> */
    tokenHash: text('token_hash').notNull(),
    /** 'run' | 'service'（后者供外部系统长期调用） */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 允许访问的 alias 白名单；空数组 = 不限制 */
    allowedModelAliases: jsonb('allowed_model_aliases')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    maxCostUsd: numeric('max_cost_usd', { precision: 12, scale: 6 }),
    maxRequestsPerMinute: integer('max_requests_per_minute'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('llm_router_tokens_hash_uniq').on(t.tokenHash),
    index('llm_router_tokens_active_idx').on(t.tokenHash).where(sql`${t.revokedAt} IS NULL`),
    index('llm_router_tokens_run_idx').on(t.runId),
    check(
      'llm_router_tokens_subject_check',
      sql`(${t.subjectType} = 'run' AND ${t.runId} IS NOT NULL) OR ${t.subjectType} = 'service'`
    ),
  ]
);
