/**
 * `llm_router_tokens` 的数据访问（M4·T4.2）。
 *
 * 与 `store/` 下三个目录 store 同款：数据访问放包里，路由层只做鉴权与投影。
 * 这里的每一条分支（未吊销、未过期、subject 归属）都能在 PGlite 上真跑。
 */
import { type DbClient, llmRouterTokens } from '@open-rush/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Subject, TokenStore } from './token-store.js';

type TokenRow = typeof llmRouterTokens.$inferSelect;

function toSubject(row: TokenRow): Subject {
  const aliases = row.allowedModelAliases;
  return {
    tokenId: row.id,
    // 列是 varchar(20) + CHECK，读出来窄化成联合类型；非法值按 'service' 兜底
    // （'run' 会让下游以为有 runId 可用）。
    subjectType: row.subjectType === 'run' ? 'run' : 'service',
    runId: row.runId,
    agentId: row.agentId,
    projectId: row.projectId,
    ownerUserId: row.ownerUserId,
    allowedModelAliases: Array.isArray(aliases) ? aliases.filter((a) => typeof a === 'string') : [],
    maxCostUsd: row.maxCostUsd,
    maxRequestsPerMinute: row.maxRequestsPerMinute,
  };
}

export class DrizzleTokenStore implements TokenStore {
  constructor(private readonly db: DbClient) {}

  /**
   * 查一条可用令牌。过期判定用**数据库时间**（`now()`）而不是进程时间——
   * 多副本之间的时钟漂移不该让同一个令牌在 A 副本可用、B 副本 401。
   */
  async findActiveByHash(tokenHash: string): Promise<Subject | null> {
    const [row] = await this.db
      .select()
      .from(llmRouterTokens)
      .where(
        and(
          eq(llmRouterTokens.tokenHash, tokenHash),
          isNull(llmRouterTokens.revokedAt),
          gt(llmRouterTokens.expiresAt, sql`now()`)
        )
      )
      .limit(1);
    return row ? toSubject(row) : null;
  }

  /** 写失败不抛：`last_used_at` 只是运营可见性，不该拖垮一次真实调用。 */
  async touchLastUsed(tokenId: string): Promise<void> {
    await this.db
      .update(llmRouterTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(llmRouterTokens.id, tokenId));
  }
}
