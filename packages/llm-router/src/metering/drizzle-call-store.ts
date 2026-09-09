/**
 * {@link CallStore} 的 drizzle 实现（M5·T5.1）。
 *
 * 一个事务里两条语句：
 *  ① `INSERT INTO llm_calls` —— 一批明细，多行一条语句；
 *  ② `INSERT INTO llm_budget_usage … ON CONFLICT DO UPDATE SET cost = cost + EXCLUDED.cost`
 *     —— 批内已按 (作用域, 窗口) 聚合过，一个冲突目标只出现一次。
 *
 * 累加放在 SQL 里做，不是「读出来加上再写回去」：后者在多副本下必然丢更新，
 * 而累计器正是预算闸门的读取源。冲突目标用列清单推断
 * （`llm_budget_usage_subject_window_uniq`，UNIQUE **NULLS NOT DISTINCT**），
 * 因此 `subject_type='global'` 那一行的 NULL `subject_id` 也能正确命中。
 */
import { type DbClient, llmBudgetUsage, llmCalls } from '@open-rush/db';
import { sql } from 'drizzle-orm';
import { aggregateBudgetDeltas } from './budget-delta.js';
import type { CallRecord } from './call-record.js';
import type { CallStore } from './call-store.js';

type CallInsert = typeof llmCalls.$inferInsert;
type UsageInsert = typeof llmBudgetUsage.$inferInsert;

function toCallRow(record: CallRecord): CallInsert {
  return {
    requestId: record.requestId,
    tokenId: record.tokenId,
    subjectType: record.subjectType,
    runId: record.runId,
    agentId: record.agentId,
    projectId: record.projectId,
    ownerUserId: record.ownerUserId,
    ccSessionId: record.ccSessionId,
    ccAgentId: record.ccAgentId,
    modelAlias: record.modelAlias,
    providerId: record.providerId,
    upstreamModel: record.upstreamModel,
    protocol: record.protocol,
    mode: record.mode,
    stream: record.stream,
    status: record.status,
    httpStatus: record.httpStatus,
    errorCode: record.errorCode,
    tokensIn: record.tokensIn,
    tokensCacheWrite: record.tokensCacheWrite,
    tokensCacheRead: record.tokensCacheRead,
    tokensOut: record.tokensOut,
    tokensReasoning: record.tokensReasoning,
    costUsd: record.costUsd,
    ttfbMs: record.ttfbMs,
    latencyMs: record.latencyMs,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

export class DrizzleCallStore implements CallStore {
  constructor(private readonly db: DbClient) {}

  async insertBatchWithBudget(batch: readonly CallRecord[]): Promise<void> {
    if (batch.length === 0) return;
    const rows = batch.map(toCallRow);
    const deltas = aggregateBudgetDeltas(batch);
    const usageRows: UsageInsert[] = deltas.map((d) => ({
      subjectType: d.subjectType,
      subjectId: d.subjectId,
      windowKey: d.windowKey,
      costUsd: d.costUsd,
      tokens: d.tokens,
      calls: d.calls,
    }));

    await this.db.transaction(async (tx) => {
      await tx.insert(llmCalls).values(rows);
      if (usageRows.length === 0) return;
      await tx
        .insert(llmBudgetUsage)
        .values(usageRows)
        .onConflictDoUpdate({
          target: [llmBudgetUsage.subjectType, llmBudgetUsage.subjectId, llmBudgetUsage.windowKey],
          set: {
            costUsd: sql`${llmBudgetUsage.costUsd} + excluded.cost_usd`,
            tokens: sql`${llmBudgetUsage.tokens} + excluded.tokens`,
            calls: sql`${llmBudgetUsage.calls} + excluded.calls`,
            updatedAt: sql`now()`,
          },
        });
    });
  }
}
