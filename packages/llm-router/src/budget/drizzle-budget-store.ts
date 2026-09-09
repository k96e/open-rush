/**
 * {@link BudgetStore} 的 drizzle 实现（M5·T5.2）。
 *
 * ⚠️ `subject_id` 可空，而 `eq(col, null)` 生成的是 `WHERE subject_id = NULL`，
 * SQL 里恒不匹配——global 那一档必须用 `IS NULL`（`llm-budgets.ts` 的表注释里
 * 专门写了这条）。所以候选条件是「每个作用域一个 AND 子句，再 OR 起来」，
 * 不能图省事写成 `inArray(subjectId, ids)`。
 */
import { type DbClient, llmBudgets, llmBudgetUsage } from '@open-rush/db';
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { BudgetRow, BudgetStore } from './budget-store.js';
import type { BudgetScope, BudgetSubjectType } from './scope.js';
import type { BudgetWindow } from './window.js';

function scopeCondition(
  scope: BudgetScope,
  typeCol: typeof llmBudgets.subjectType | typeof llmBudgetUsage.subjectType,
  idCol: typeof llmBudgets.subjectId | typeof llmBudgetUsage.subjectId
): SQL {
  const byType = eq(typeCol, scope.subjectType);
  const byId = scope.subjectId === null ? isNull(idCol) : eq(idCol, scope.subjectId);
  return and(byType, byId) as SQL;
}

export class DrizzleBudgetStore implements BudgetStore {
  constructor(private readonly db: DbClient) {}

  async findBudgets(scopes: readonly BudgetScope[]): Promise<BudgetRow[]> {
    if (scopes.length === 0) return [];
    const conditions = scopes.map((s) =>
      scopeCondition(s, llmBudgets.subjectType, llmBudgets.subjectId)
    );
    const rows = await this.db
      .select({
        subjectType: llmBudgets.subjectType,
        subjectId: llmBudgets.subjectId,
        window: llmBudgets.window,
        limitUsd: llmBudgets.limitUsd,
        enforce: llmBudgets.enforce,
      })
      .from(llmBudgets)
      .where(conditions.length === 1 ? conditions[0] : or(...conditions));

    // varchar 收窄回联合类型；DB 侧的 CHECK 约束是兜底。
    return rows.map((row) => ({
      subjectType: row.subjectType as BudgetSubjectType,
      subjectId: row.subjectId,
      window: row.window as BudgetWindow,
      limitUsd: row.limitUsd,
      enforce: row.enforce,
    }));
  }

  async findUsage(
    scope: BudgetScope,
    windowKeys: readonly string[]
  ): Promise<Record<string, string>> {
    if (windowKeys.length === 0) return {};
    const rows = await this.db
      .select({ windowKey: llmBudgetUsage.windowKey, costUsd: llmBudgetUsage.costUsd })
      .from(llmBudgetUsage)
      .where(
        and(
          scopeCondition(scope, llmBudgetUsage.subjectType, llmBudgetUsage.subjectId),
          inArray(llmBudgetUsage.windowKey, [...windowKeys])
        )
      );

    const used: Record<string, string> = {};
    for (const row of rows) used[row.windowKey] = row.costUsd;
    return used;
  }
}
