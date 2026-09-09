/**
 * {@link RouterTokenStore} 的 drizzle 实现（M6·T6.1）。
 *
 * 两张表：`llm_router_tokens`（签发 / 吊销）与 `llm_calls`（聚合）。
 * 聚合刻意不加 `status = 'success'` 过滤——被拒的调用 token 数本来就是 0，
 * 而一次「上游中途断流」的调用已经花掉的 token 该算进账里。
 */
import { type DbClient, llmCalls, llmRouterTokens } from '@open-rush/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type {
  CreateRouterTokenInput,
  RouterTokenStore,
  RunUsageTotals,
} from './router-token-store.js';

/** `SUM()` 在 PG 上回 numeric/bigint，驱动给到的是字符串；空结果是 null。 */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class DrizzleRouterTokenStore implements RouterTokenStore {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateRouterTokenInput): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(llmRouterTokens)
      .values({
        tokenHash: input.tokenHash,
        subjectType: input.subjectType,
        runId: input.runId,
        agentId: input.agentId,
        projectId: input.projectId,
        ownerUserId: input.ownerUserId,
        allowedModelAliases: input.allowedModelAliases,
        expiresAt: input.expiresAt,
      })
      .returning({ id: llmRouterTokens.id });
    return { id: row.id };
  }

  /**
   * `revoked_at` 用**数据库时间**（`now()`）而不是进程时间：与
   * `DrizzleTokenStore.findActiveByHash` 的过期判定同一把尺子，多副本之间的
   * 时钟漂移不会让某个令牌在「已吊销」与「还没到吊销时刻」之间摇摆。
   */
  async revokeByRunId(runId: string): Promise<number> {
    const rows = await this.db
      .update(llmRouterTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(llmRouterTokens.runId, runId), isNull(llmRouterTokens.revokedAt)))
      .returning({ id: llmRouterTokens.id });
    return rows.length;
  }

  async aggregateCallsByRun(runId: string): Promise<RunUsageTotals | null> {
    const [row] = await this.db
      .select({
        calls: sql<string>`count(*)`,
        tokensIn: sql<
          string | null
        >`sum(${llmCalls.tokensIn} + ${llmCalls.tokensCacheWrite} + ${llmCalls.tokensCacheRead})`,
        tokensOut: sql<string | null>`sum(${llmCalls.tokensOut})`,
        costUsd: sql<string | null>`sum(${llmCalls.costUsd})`,
      })
      .from(llmCalls)
      .where(eq(llmCalls.runId, runId));

    if (!row || toNumber(row.calls) === 0) return null;
    return {
      tokensIn: toNumber(row.tokensIn),
      tokensOut: toNumber(row.tokensOut),
      costUsd: toNumber(row.costUsd),
    };
  }
}
