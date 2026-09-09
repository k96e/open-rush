/**
 * per-run 接入令牌的数据访问接口（M6·T6.1）。
 *
 * 与 `packages/llm-router` 里的 {@link TokenStore} 是**两条方向相反的路**：
 * 网关只读（`findActiveByHash`），控制面只写（签发 / 吊销）+ 读聚合。
 * 拆成两个接口而不是一个大接口，是为了让网关进程连「能签发令牌」的代码都没有。
 *
 * D6「令牌即归属」：这里写进去的 run / agent / project / owner 就是网关那边
 * 认出来的 subject，也是 `llm_calls` 的归属列来源。
 */

export interface CreateRouterTokenInput {
  /** SHA-256(明文) hex。明文由调用方保管，**不入库**。 */
  tokenHash: string;
  subjectType: 'run' | 'service';
  runId: string | null;
  agentId: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  /** 空数组 = 不限制；per-run 令牌只放这次 run 要用的那一个 alias（最小权限）。 */
  allowedModelAliases: string[];
  expiresAt: Date;
}

/** run 收敛时回写 `data-openrush-usage` 用的聚合结果（D8 / A5）。 */
export interface RunUsageTotals {
  /** 输入侧总量 = 非缓存输入 + 缓存写 + 缓存读。 */
  tokensIn: number;
  /** 输出侧总量（Anthropic 的 thinking、OpenAI 的 reasoning 都已计入 output）。 */
  tokensOut: number;
  costUsd: number;
}

export interface RouterTokenStore {
  create(input: CreateRouterTokenInput): Promise<{ id: string }>;
  /**
   * 吊销该 run 名下**所有**未吊销的令牌，返回被吊销的行数。
   * 幂等：重复调用只是又跑一次 `WHERE revoked_at IS NULL` 的 UPDATE，命中 0 行。
   */
  revokeByRunId(runId: string): Promise<number>;
  /** 无记录返回 null——「这个 run 一次模型都没调」与「调了但都是 0」要分得开。 */
  aggregateCallsByRun(runId: string): Promise<RunUsageTotals | null>;
}
