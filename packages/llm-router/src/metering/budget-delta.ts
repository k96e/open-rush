/**
 * 一批 `llm_calls` → 一组 `llm_budget_usage` 增量（M5·T5.1）。
 *
 * 为什么必须先在内存里聚合再写库，有两个各自独立的理由：
 *  ① PostgreSQL 的 `INSERT … ON CONFLICT DO UPDATE` **不允许同一条冲突目标在一条
 *    语句里被命中两次**（"cannot affect row a second time"）。一批 100 条调用几乎
 *    必然落在同一个 (作用域, 窗口) 桶里，不去重这条语句直接报错，整批被丢。
 *  ② 一次调用要进 4 档作用域 × 3 个窗口最多 12 个桶，聚合之后一批只写十几行。
 *
 * 金额一律走定点 BigInt（微美元）。`cost_usd` 是 `numeric(12,6)`，用 float 累加
 * 一万次就能攒出肉眼可见的对账差——这与 `usage/cost.ts` 是同一条理由。
 */
import type { BudgetScope, BudgetSubjectType } from '../budget/scope.js';
import { scopeKey } from '../budget/scope.js';
import { BUDGET_WINDOWS, windowKeyFor } from '../budget/window.js';
import { formatMicrosUsd, parsePriceToMicros } from '../usage/cost.js';
import type { CallRecord } from './call-record.js';

export interface BudgetDelta {
  subjectType: BudgetSubjectType;
  subjectId: string | null;
  windowKey: string;
  /** `numeric(14,6)` 可直接写入的字符串。 */
  costUsd: string;
  /**
   * 四类计数之和。**不含 `tokensReasoning`**——它是 `tokensOut` 的子集
   * （OpenAI 的 `reasoning_tokens` 计在 `completion_tokens` 里），加上就是重复计数。
   */
  tokens: number;
  calls: number;
}

/** 一条调用要进的所有桶：非空的归属列各一档，外加恒定的 global。 */
function scopesOf(record: CallRecord): BudgetScope[] {
  const scopes: BudgetScope[] = [{ subjectType: 'global', subjectId: null }];
  if (record.projectId) scopes.push({ subjectType: 'project', subjectId: record.projectId });
  if (record.ownerUserId) scopes.push({ subjectType: 'user', subjectId: record.ownerUserId });
  if (record.agentId) scopes.push({ subjectType: 'agent', subjectId: record.agentId });
  return scopes;
}

function tokensOf(record: CallRecord): number {
  return record.tokensIn + record.tokensCacheWrite + record.tokensCacheRead + record.tokensOut;
}

/**
 * 聚合成**每个 (作用域, 窗口键) 一行**的增量。
 *
 * 窗口键按 `startedAt` 切——与 `llm_calls` 的索引列一致，跨零点的长流式调用因此
 * 记在它开始的那一天，不会因为写库时机的抖动在两个桶之间漂。
 */
export function aggregateBudgetDeltas(records: readonly CallRecord[]): BudgetDelta[] {
  const buckets = new Map<
    string,
    { scope: BudgetScope; windowKey: string; micros: bigint; tokens: number; calls: number }
  >();

  for (const record of records) {
    const micros = parsePriceToMicros(record.costUsd);
    const tokens = tokensOf(record);
    for (const scope of scopesOf(record)) {
      for (const window of BUDGET_WINDOWS) {
        const windowKey = windowKeyFor(window, record.startedAt);
        const key = `${scopeKey(scope)}|${windowKey}`;
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.micros += micros;
          bucket.tokens += tokens;
          bucket.calls += 1;
        } else {
          buckets.set(key, { scope, windowKey, micros, tokens, calls: 1 });
        }
      }
    }
  }

  return [...buckets.values()].map((b) => ({
    subjectType: b.scope.subjectType,
    subjectId: b.scope.subjectId,
    windowKey: b.windowKey,
    costUsd: formatMicrosUsd(b.micros),
    tokens: b.tokens,
    calls: b.calls,
  }));
}
