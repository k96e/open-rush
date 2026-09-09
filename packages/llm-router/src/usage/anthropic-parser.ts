/**
 * Anthropic Messages 的用量解析（M4·T4.4，C2 §7.4）。
 *
 * 协议要点：
 *  - `message_start.message.usage` 给出 input / cache 的初值；
 *  - `message_delta.usage` 是**累计值**（cumulative），且通常只带 `output_tokens`；
 *  - thinking token 已计入 `output_tokens`，wire 上没有独立字段（R4 §5.6 注），
 *    所以 `tokensReasoning` 恒为 0。
 *
 * 因此各字段用 max() 单调合并：缺字段保持不变，重复出现取大者，
 * 「只有 message_start 没有 message_delta」也能出数。
 */
import { mergeMax, parseJsonObject, SseLineReader } from './sse-line-reader.js';
import { EMPTY_WIRE_USAGE, type UsageParser, type UsageResult, type WireUsage } from './types.js';

const DECODER = new TextDecoder();

export class AnthropicSseUsageParser implements UsageParser {
  private readonly lines = new SseLineReader();
  private readonly usage: WireUsage = { ...EMPTY_WIRE_USAGE };
  private upstreamModel: string | null = null;
  private stopReason: string | null = null;

  push(chunk: Uint8Array): void {
    for (const payload of this.lines.push(chunk)) {
      const evt = parseJsonObject(payload);
      if (!evt) continue;
      if (evt.type === 'message_start') {
        const msg = evt.message as Record<string, unknown> | undefined;
        this.upstreamModel = typeof msg?.model === 'string' ? msg.model : this.upstreamModel;
        this.merge(msg?.usage);
      } else if (evt.type === 'message_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') this.stopReason = delta.stop_reason;
        this.merge(evt.usage);
      }
    }
  }

  /** 非流式：直接喂整个 JSON body（只读副本，不改动原字节）。 */
  pushNonStreamBody(body: Uint8Array): void {
    const json = parseJsonObject(DECODER.decode(body));
    if (!json) return;
    if (typeof json.model === 'string') this.upstreamModel = json.model;
    if (typeof json.stop_reason === 'string') this.stopReason = json.stop_reason;
    this.merge(json.usage);
  }

  private merge(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const u = raw as Record<string, unknown>;
    this.usage.tokensIn = mergeMax(this.usage.tokensIn, u.input_tokens);
    this.usage.tokensCacheWrite = mergeMax(
      this.usage.tokensCacheWrite,
      u.cache_creation_input_tokens
    );
    this.usage.tokensCacheRead = mergeMax(this.usage.tokensCacheRead, u.cache_read_input_tokens);
    this.usage.tokensOut = mergeMax(this.usage.tokensOut, u.output_tokens);
  }

  result(): UsageResult {
    return { ...this.usage, upstreamModel: this.upstreamModel, stopReason: this.stopReason };
  }
}
