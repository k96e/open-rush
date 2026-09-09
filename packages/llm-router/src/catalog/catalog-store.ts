/**
 * 目录快照的数据访问接口（M3·T3.1）。
 *
 * 拆成 interface 是为了让 {@link CatalogCache} 的单测能用假 store 精确断言
 * 「version 未变时**一次 loadSnapshot 都不发**」这类调用次数命题——用真库测
 * 不出「没有发生的查询」。
 */
import type { Snapshot } from './types.js';

export interface CatalogStore {
  /**
   * 只 SELECT `llm_catalog_state` 单行的版本位。轮询兜底每次都调它，
   * 所以必须是**零成本**的——不要在这里顺手做别的查询。
   */
  readVersion(): Promise<number>;

  /**
   * 加载完整快照。`version` 由调用方从 {@link readVersion} 带进来，
   * 原样写进 {@link Snapshot.version}。
   */
  loadSnapshot(version: number): Promise<Snapshot>;
}
