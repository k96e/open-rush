/**
 * 调用方令牌的归属类型与数据访问接口（M4·T4.2）。
 *
 * D6「令牌即归属」：{@link Subject} 的每一个字段都来自 `llm_router_tokens` 这一行，
 * **没有一个来自请求头**。沙箱里有 bash，`x-claude-code-*` 想写什么写什么，
 * 那些值只进 `llm_calls.cc_*` 作下钻分组，不参与授权与计费。
 */

/** 认证结果 = 归属 + 配额。字段与 `llm_router_tokens` 一一对应。 */
export interface Subject {
  tokenId: string;
  subjectType: 'run' | 'service';
  runId: string | null;
  agentId: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  /** 空数组 = 不限制（与 `llm_router_tokens.allowed_model_aliases` 的默认值同义）。 */
  allowedModelAliases: string[];
  maxCostUsd: string | null;
  maxRequestsPerMinute: number | null;
}

export interface TokenStore {
  /** `revoked_at IS NULL AND expires_at > now()`；不满足即视为不存在。 */
  findActiveByHash(tokenHash: string): Promise<Subject | null>;
  /** fire-and-forget，失败不影响认证结果。 */
  touchLastUsed(tokenId: string): Promise<void>;
}

/** 令牌是否允许访问某个 alias。空白名单 = 放行一切。 */
export function isAliasAllowed(subject: Subject, alias: string): boolean {
  return subject.allowedModelAliases.length === 0 || subject.allowedModelAliases.includes(alias);
}
