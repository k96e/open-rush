/**
 * 为一次 Run 签发 llm-router 接入凭据（M6·T6.1，C8 §7.15，D5 / D6 / D12）。
 *
 * 时序（`ref/R3` §4.2）：
 *   签发 → 注入沙箱 env → run 跑完 → 聚合用量 → **finally 里吊销**。
 *
 * 沙箱里拿到的是这里铸出来的短时令牌，不是供应商真 key：即使 agent 有 bash，
 * 偷到的也只是一个分钟级、随 run 吊销、只能打到本网关的字符串（D12）。
 *
 * ⚠️ 明文只在 {@link LlmAccessService.issueForRun} 的返回值里出现一次。
 * 它会进沙箱 env，**不得**进日志、不得回写 DB、不得进 `run_events`。
 */
import { hashRouterToken, mintRouterToken } from '@open-rush/llm-router/token';
import type { RouterTokenStore, RunUsageTotals } from './router-token-store.js';

/** 签发结果。`env` 直接展开进 sandbox env / providerEnv。 */
export interface LlmGrant {
  tokenId: string;
  env: Record<string, string>;
}

export interface LlmAccessConfig {
  /** 网关内网地址，例如 `http://llm-router:8790`。 */
  routerBaseUrl: string;
  /** 默认 3900s = 沙箱 ttl 3600s + 5 分钟缓冲。 */
  defaultTtlSeconds?: number;
}

export interface IssueForRunInput {
  runId: string;
  agentId: string;
  projectId: string;
  ownerUserId: string | null;
  modelAlias: string;
  ttlSeconds?: number;
}

/** 令牌 ttl 缺省值：沙箱 ttl（3600s）+ 5 分钟缓冲。 */
export const DEFAULT_ROUTER_TOKEN_TTL_SECONDS = 3900;

export class LlmAccessService {
  constructor(
    private readonly store: RouterTokenStore,
    private readonly config: LlmAccessConfig
  ) {}

  async issueForRun(ctx: IssueForRunInput): Promise<LlmGrant> {
    const { plaintext, tokenHash } = mintRouterToken();
    const ttlSeconds =
      ctx.ttlSeconds ?? this.config.defaultTtlSeconds ?? DEFAULT_ROUTER_TOKEN_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const row = await this.store.create({
      tokenHash,
      subjectType: 'run',
      runId: ctx.runId,
      agentId: ctx.agentId,
      projectId: ctx.projectId,
      ownerUserId: ctx.ownerUserId,
      // 最小权限：这个 run 只能用这一个 alias。
      allowedModelAliases: [ctx.modelAlias],
      expiresAt,
    });

    return {
      tokenId: row.id,
      env: {
        ANTHROPIC_BASE_URL: this.config.routerBaseUrl,
        // 用 AUTH_TOKEN 而非 API_KEY：Claude Code 把它放进 `Authorization: Bearer`，
        // 且这个变量立即生效（API_KEY 在交互模式下要先确认一次）。
        ANTHROPIC_AUTH_TOKEN: plaintext,
        ANTHROPIC_MODEL: ctx.modelAlias,
      },
    };
  }

  /**
   * 吊销该 run 的全部令牌。**幂等**——重复调用只是多一次命中 0 行的 UPDATE。
   * 调用点在 `RunOrchestrator` 的 `finally` 里，成功与失败路径都要走到。
   */
  async revokeForRun(runId: string): Promise<number> {
    return this.store.revokeByRunId(runId);
  }

  /** run 收敛时聚合逐调用记录，喂给 `data-openrush-usage`（D8 / A5）。 */
  async aggregateUsage(runId: string): Promise<RunUsageTotals | null> {
    return this.store.aggregateCallsByRun(runId);
  }

  /**
   * 供上层做「这个明文对应库里哪一行」的比对（例如排障时核对沙箱 env）。
   * 单独暴露而不是让调用方去 import `@open-rush/llm-router/token`，是为了让
   * 「control-plane 只碰铸造与哈希」这条依赖约束只出现在本文件一处。
   */
  static hashToken(plaintext: string): string {
    return hashRouterToken(plaintext);
  }
}
