/**
 * 逐调用计量记录的形状与写入接口（M4 立的缝，M5·T5.1 落实现）。
 *
 * 为什么 M4 就要有这个文件：`forward.ts` 在四条路径上都要出数（成功 / 上游错误 /
 * 解封失败 / 客户端断开），把记录形状定下来，M5 只需要换一个 {@link CallRecorder}
 * 的实现，转发路径一行都不用改。
 *
 * 字段与 `llm_calls` 的列一一对应（R4 §5.6）。归属列来自令牌（D6），
 * `cc*` 列来自 `x-claude-code-*` 头——**沙箱内可伪造，只用于下钻分组**。
 */
import type { CatalogProtocol, CatalogRouteMode } from '../catalog/types.js';
import type { CallStatus } from '../proxy/router-errors.js';

export interface CallRecord {
  requestId: string | null;
  tokenId: string | null;
  subjectType: 'run' | 'service';
  runId: string | null;
  agentId: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  ccSessionId: string | null;
  ccAgentId: string | null;
  modelAlias: string;
  providerId: string | null;
  upstreamModel: string | null;
  protocol: CatalogProtocol;
  /** `translate` 是跨协议翻译（T4.7）；同协议只会是 passthrough / rewrite-model。 */
  mode: CatalogRouteMode | 'translate';
  stream: boolean;
  status: CallStatus;
  httpStatus: number | null;
  errorCode: string | null;
  tokensIn: number;
  tokensCacheWrite: number;
  tokensCacheRead: number;
  tokensOut: number;
  tokensReasoning: number;
  costUsd: string;
  ttfbMs: number | null;
  latencyMs: number | null;
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * 写入口。**实现必须是非阻塞且不抛的**——A5 要求计量失败不影响上层调用，
 * 所以 `enqueue` 返回 void，转发路径既不 await 也不 catch。
 */
export interface CallRecorder {
  enqueue(record: CallRecord): void;
}

/**
 * 不落库的实现。用于：
 *  - 单测（断言转发路径出了哪几条记录）；
 *  - `LLM_ROUTER_METERING_ENABLED=false` 的部署；
 *  - M5 接上 `DrizzleCallStore` 之前的 M4 装配。
 */
export class InMemoryCallRecorder implements CallRecorder {
  readonly records: CallRecord[] = [];

  enqueue(record: CallRecord): void {
    this.records.push(record);
  }
}

/** 连内存都不占的实现。 */
export const NOOP_CALL_RECORDER: CallRecorder = { enqueue: () => {} };
