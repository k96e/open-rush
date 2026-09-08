import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { llmCredentials } from './llm-credentials.js';

/**
 * 上游供应商：协议族 + baseUrl + 凭据引用。
 *
 * `credential_id` 用 ON DELETE RESTRICT——凭据被引用时不允许删除，
 * 否则在途请求会突然失去认证材料（控制台需先解绑再删）。
 */
export const llmProviders = pgTable(
  'llm_providers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull().unique(),
    /** 上游协议族：'anthropic' | 'openai' */
    protocol: varchar('protocol', { length: 20 }).notNull(),
    /** 不含尾斜杠，如 https://api.anthropic.com */
    baseUrl: text('base_url').notNull(),
    credentialId: uuid('credential_id').references(() => llmCredentials.id, {
      onDelete: 'restrict',
    }),
    /** 附加请求头（非敏感），如 { "X-Tenant": "rush" } */
    defaultHeaders: jsonb('default_headers')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** 上游超时；SSE 长流场景默认 10 分钟 */
    timeoutMs: integer('timeout_ms').notNull().default(600_000),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('llm_providers_enabled_idx').on(t.enabled),
    check('llm_providers_protocol_check', sql`${t.protocol} IN ('anthropic','openai')`),
  ]
);
