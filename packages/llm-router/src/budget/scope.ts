/**
 * 预算作用域与解析顺序（M5·T5.2）。
 *
 * 优先级 `agent → project → user → global`，**取最近的一档**（R4 §5.7、
 * `specs/llm-router.md` §计量、预算、限流）：命中最靠近调用者的那一档之后就不再
 * 往上找。这是「就近覆盖」语义——给某个项目单独抬额度时，不必再去动全局那一行。
 *
 * 归属字段全部来自令牌（D6），所以作用域也全部来自令牌：沙箱里改请求头改不动它。
 */
import type { Subject } from '../auth/token-store.js';

/** 与 `llm_budgets.subject_type` 的 CHECK 约束同源。 */
export type BudgetSubjectType = 'global' | 'project' | 'user' | 'agent';

export interface BudgetScope {
  subjectType: BudgetSubjectType;
  /** `global` 恒为 null；其余三档必然非 null。 */
  subjectId: string | null;
}

/** 候选作用域，**按优先级从近到远**排列。null 的归属列直接跳过。 */
export function resolveScopes(subject: Subject): BudgetScope[] {
  const scopes: BudgetScope[] = [];
  if (subject.agentId) scopes.push({ subjectType: 'agent', subjectId: subject.agentId });
  if (subject.projectId) scopes.push({ subjectType: 'project', subjectId: subject.projectId });
  if (subject.ownerUserId) scopes.push({ subjectType: 'user', subjectId: subject.ownerUserId });
  scopes.push({ subjectType: 'global', subjectId: null });
  return scopes;
}

/** 作用域的字符串键。用于缓存 Map 与批内聚合，**不落库**。 */
export function scopeKey(scope: BudgetScope): string {
  return `${scope.subjectType}:${scope.subjectId ?? ''}`;
}
