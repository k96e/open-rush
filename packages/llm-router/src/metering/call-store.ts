/**
 * 计量的落库接口（M5·T5.1）。
 *
 * 只有一个方法，且它的语义里写死了「同一个事务」：`llm_calls` 的明细与
 * `llm_budget_usage` 的累加必须一起成功或一起失败（R4 §5.7）。分成两次写，
 * 任何一次失败都会让明细与累计器永久对不上——而累计器正是预算闸门的读取源。
 */
import type { CallRecord } from './call-record.js';

export interface CallStore {
  /**
   * 一个事务里：INSERT 明细 + `ON CONFLICT DO UPDATE` 累加预算。
   *
   * 允许抛错——{@link BatchingCallRecorder} 会接住、计数、告警，**不回队**。
   */
  insertBatchWithBudget(batch: readonly CallRecord[]): Promise<void>;
}
