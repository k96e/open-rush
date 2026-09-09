/**
 * 预算窗口的键与边界（M5·T5.1 / T5.2，R4 §5.7）。
 *
 * 三个窗口全部按 **UTC** 切：`llm_budget_usage.window_key` 是一个只有 20 字符的
 * varchar，跨时区解释它会让同一行在两个副本眼里落在不同的日子。累计器是全局共享的，
 * 时区必须是常量而不是部署环境的属性。
 *
 * `total` 没有边界——它是「自建库以来」的累计。但 429 一律要带 `Retry-After`
 * （R5 §6.2），所以给它一个固定的兜底值：超了 total 预算只有运营方抬额度才有救，
 * 让客户端一小时后再来，比让它每秒重试要好。
 */

/** 与 `llm_budgets.window` 的 CHECK 约束、契约的 `llmBudgetWindowSchema` 同源。 */
export type BudgetWindow = 'day' | 'month' | 'total';

/** 累计器要维护的窗口全集。一次调用同时进这三个桶。 */
export const BUDGET_WINDOWS: readonly BudgetWindow[] = ['day', 'month', 'total'] as const;

/** `total` 窗口超限时的 `Retry-After`（秒）。 */
export const TOTAL_WINDOW_RETRY_AFTER_SEC = 3600;

const DAY_MS = 86_400_000;

/** `'day'` → `'2026-09-08'`；`'month'` → `'2026-09'`；`'total'` → `'total'`（全部 UTC）。 */
export function windowKeyFor(window: BudgetWindow, at: Date): string {
  const iso = at.toISOString();
  if (window === 'day') return iso.slice(0, 10);
  if (window === 'month') return iso.slice(0, 7);
  return 'total';
}

/**
 * 到窗口边界还有多少秒（向上取整，至少 1）。预算 429 的 `Retry-After` 取这个值。
 *
 * 至少 1 是刻意的：边界那一毫秒返回 `Retry-After: 0` 会让客户端立刻重试，
 * 而此刻累计器多半还没跨过去，等于让它空转一轮。
 */
export function secondsToWindowEnd(window: BudgetWindow, at: Date): number {
  if (window === 'total') return TOTAL_WINDOW_RETRY_AFTER_SEC;
  const ms = at.getTime();
  if (window === 'day') {
    const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    return Math.max(1, Math.ceil((dayStart + DAY_MS - ms) / 1000));
  }
  const monthEnd = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((monthEnd - ms) / 1000));
}
