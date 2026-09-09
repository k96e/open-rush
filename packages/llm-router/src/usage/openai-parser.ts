/**
 * OpenAI Chat Completions 的用量解析（M4·T4.4/T4.6，C2 §7.4 注）。
 *
 * 与 Anthropic 面的两点差异：
 *  1. 流式下 usage 只在**最后一个 chunk**（`choices: []`）里出现，且需要请求带
 *     `stream_options.include_usage=true`——这条注入由路由层负责（T4.6），
 *     注入后该次调用的 `llm_calls.mode` 记为 `rewrite-model`。
 *  2. `prompt_tokens` **含**缓存命中部分，所以 `tokensIn` 要减掉 `cached_tokens`，
 *     否则缓存读会被按全价重复计一次。
 *
 * 与 Anthropic 面相同的是：usage 是累计/终值语义，用 max() 单调合并。
 */
import { mergeMax, parseJsonObject, SseLineReader } from './sse-line-reader.js';
import { EMPTY_WIRE_USAGE, type UsageParser, type UsageResult, type WireUsage } from './types.js';

const DECODER = new TextDecoder();

export class OpenAiSseUsageParser implements UsageParser {
  private readonly lines = new SseLineReader();
  private readonly usage: WireUsage = { ...EMPTY_WIRE_USAGE };
  private upstreamModel: string | null = null;
  private stopReason: string | null = null;

  push(chunk: Uint8Array): void {
    for (const payload of this.lines.push(chunk)) {
      const evt = parseJsonObject(payload);
      if (!evt) continue;
      this.absorb(evt);
    }
  }

  pushNonStreamBody(body: Uint8Array): void {
    const json = parseJsonObject(DECODER.decode(body));
    if (json) this.absorb(json);
  }

  private absorb(evt: Record<string, unknown>): void {
    if (typeof evt.model === 'string') this.upstreamModel = evt.model;
    const choices = evt.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown> | undefined;
      if (typeof first?.finish_reason === 'string') this.stopReason = first.finish_reason;
    }
    this.merge(evt.usage);
  }

  private merge(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const u = raw as Record<string, unknown>;
    const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined;
    const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined;
    const cachedRaw = promptDetails?.cached_tokens;
    const cached = typeof cachedRaw === 'number' && Number.isFinite(cachedRaw) ? cachedRaw : 0;

    // prompt_tokens 含缓存命中，减掉后才是「非缓存输入」（与 llm_calls.tokens_in 同义）。
    const promptRaw = u.prompt_tokens;
    if (typeof promptRaw === 'number' && Number.isFinite(promptRaw)) {
      this.usage.tokensIn = mergeMax(this.usage.tokensIn, Math.max(0, promptRaw - cached));
    }
    this.usage.tokensCacheRead = mergeMax(this.usage.tokensCacheRead, cached);
    // OpenAI 面没有「缓存写入」这一计量维度，恒为 0。
    this.usage.tokensOut = mergeMax(this.usage.tokensOut, u.completion_tokens);
    this.usage.tokensReasoning = mergeMax(
      this.usage.tokensReasoning,
      completionDetails?.reasoning_tokens
    );
  }

  result(): UsageResult {
    return { ...this.usage, upstreamModel: this.upstreamModel, stopReason: this.stopReason };
  }
}
