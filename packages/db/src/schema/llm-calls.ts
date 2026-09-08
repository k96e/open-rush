import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { llmRouterTokens } from './llm-router-tokens.js';
import { runs } from './runs.js';

/**
 * 一行 = 一次上游 LLM 调用。这是「逐调用计量」的真相表（F5/A5）。
 * 写入是**异步、批量、失败不阻塞**的——计量挂掉不得影响转发。
 *
 * 归属列（subject_type 与 run / agent / project / owner）来自令牌而非 header（D6）；
 * `cc_*` 列来自 `x-claude-code-*` 头，沙箱内可伪造，**只用于下钻分组**。
 *
 * `provider_id` / `agent_id` / `project_id` / `owner_user_id` 刻意不建外键：
 * 计量是历史事实，供应商或项目被删除后这些行仍应保留原值。
 * `run_id` 例外——run 级联删除时明细一并清理（与 run_events 一致）。
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 复用 packages/observability 的 request-id（x-request-id） */
    requestId: varchar('request_id', { length: 64 }),
    tokenId: uuid('token_id').references(() => llmRouterTokens.id, { onDelete: 'set null' }),
    // ── 归属（来自令牌，非 header；D6）──
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id'),
    projectId: uuid('project_id'),
    ownerUserId: uuid('owner_user_id'),
    // ── 分组提示（来自 header，不可信，仅用于下钻）──
    ccSessionId: varchar('cc_session_id', { length: 128 }),
    ccAgentId: varchar('cc_agent_id', { length: 128 }),
    // ── 路由 ──
    modelAlias: varchar('model_alias', { length: 255 }).notNull(),
    providerId: uuid('provider_id'),
    upstreamModel: varchar('upstream_model', { length: 255 }),
    protocol: varchar('protocol', { length: 20 }).notNull(),
    /** 'passthrough' | 'rewrite-model' | 'translate' */
    mode: varchar('mode', { length: 20 }).notNull(),
    stream: boolean('stream').notNull().default(false),
    // ── 结果 ──
    /**
     * success | upstream_error | rate_limited | budget_exceeded | client_abort
     * | router_error | unauthorized | forbidden | model_not_found
     * （与 contracts 的 `llmCallStatusSchema` 一一对应）
     */
    status: varchar('status', { length: 30 }).notNull(),
    httpStatus: integer('http_status'),
    errorCode: varchar('error_code', { length: 50 }),
    // ── token 拆分（A5：「推理 token 尤须拆开」）──
    /** 非缓存输入 */
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensCacheWrite: integer('tokens_cache_write').notNull().default(0),
    tokensCacheRead: integer('tokens_cache_read').notNull().default(0),
    /** 含 thinking（Anthropic 的 thinking token 已计入 output，wire 上没有独立字段） */
    tokensOut: integer('tokens_out').notNull().default(0),
    /** OpenAI completion_tokens_details.reasoning_tokens；Anthropic 上游恒为 0 */
    tokensReasoning: integer('tokens_reasoning').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    // ── 性能 ──
    ttfbMs: integer('ttfb_ms'),
    latencyMs: integer('latency_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('llm_calls_run_idx').on(t.runId, t.startedAt),
    index('llm_calls_project_started_idx').on(t.projectId, t.startedAt),
    index('llm_calls_session_idx').on(t.ccSessionId),
    index('llm_calls_status_idx').on(t.status, t.startedAt),
    // 覆盖 token_id 外键：删 run 会级联删 llm_router_tokens，PG 随后要把本表
    // （全库最大的一张）里的 token_id 置 NULL——没有这个索引就是一次全表扫描。
    index('llm_calls_token_idx').on(t.tokenId),
  ]
);
