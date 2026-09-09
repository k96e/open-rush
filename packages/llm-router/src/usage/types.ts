/**
 * 用量解析的共享类型（M4·T4.4）。
 *
 * 五个 token 计数与 `llm_calls` 的五列一一对应（R4 §5.6）：
 *  - `tokensIn` 是**非缓存**输入（OpenAI 面要减掉 `cached_tokens`）；
 *  - Anthropic 的 thinking token 已计入 `output_tokens`，wire 上没有独立字段，
 *    所以 `tokensReasoning` 在 Anthropic 上游恒为 0；
 *  - OpenAI 面的 `reasoning_tokens` 是 `completion_tokens` 的子集，计价时按
 *    `priceReasoningPerMtok` **额外**计一份（见 `cost.ts` 的注）。
 */

export interface WireUsage {
  tokensIn: number;
  tokensCacheWrite: number;
  tokensCacheRead: number;
  tokensOut: number;
  tokensReasoning: number;
}

/** 解析结果 = 用量 + 上游实际用的模型名 + 停止原因。后两者只用于记录，不参与计价。 */
export interface UsageResult extends WireUsage {
  upstreamModel: string | null;
  stopReason: string | null;
}

/**
 * 增量用量解析器。**始终工作在旁路**——所有方法都不得抛错到转发链路上，
 * 内部自行吞掉畸形输入（A5：计量失败不阻塞上层调用）。
 */
export interface UsageParser {
  /** 流式：喂一个上游 chunk 的**副本语义**（不修改入参）。 */
  push(chunk: Uint8Array): void;
  /** 非流式：喂完整响应体。 */
  pushNonStreamBody(body: Uint8Array): void;
  result(): UsageResult;
}

export const EMPTY_WIRE_USAGE: WireUsage = {
  tokensIn: 0,
  tokensCacheWrite: 0,
  tokensCacheRead: 0,
  tokensOut: 0,
  tokensReasoning: 0,
};
