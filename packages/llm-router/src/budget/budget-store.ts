/**
 * 预算配置与累计值的读取接口（M5·T5.2）。
 *
 * 刻意做成「一次查完所有候选作用域」而不是「一档查一次」：一次调用最多有
 * agent / project / user / global 四个候选，逐档查在缓存未命中时就是四个来回。
 * 闸门坐在转发路径上，来回次数直接算进 TTFB。
 */
import type { BudgetScope, BudgetSubjectType } from './scope.js';
import type { BudgetWindow } from './window.js';

export interface BudgetRow {
  subjectType: BudgetSubjectType;
  subjectId: string | null;
  window: BudgetWindow;
  /** `numeric(12,6)` 的字符串形态。 */
  limitUsd: string;
  /** false = observe（只计量不拦截）；true = enforce。 */
  enforce: boolean;
}

export interface BudgetStore {
  /** 一次取回这些作用域上配置的**全部**预算行（同一作用域可能三个窗口各一行）。 */
  findBudgets(scopes: readonly BudgetScope[]): Promise<BudgetRow[]>;
  /**
   * 某作用域在若干窗口键上的累计花费。**缺行按 `'0'`**——累计器是懒创建的，
   * 没有行只意味着这个窗口还没花过钱。
   */
  findUsage(scope: BudgetScope, windowKeys: readonly string[]): Promise<Record<string, string>>;
}
