/**
 * 翻译器注册表（M4·T4.7）。
 *
 * **只有一个方向被交付**：`anthropic` 面 → `openai` 上游。这不是偷懒，是范围
 * 的一部分——`specs/llm-router.md` §协议承诺分层 把 `translate` 定义成
 * 「调用方协议 != 上游协议（**Anthropic-in → OpenAI-out**）」。
 *
 * 反方向（OpenAI 面的调用方打 Anthropic 上游）返回 null，路由层维持 404 +
 * `PROTOCOL_FACE_MISMATCH`。**明确拒绝好过半成品的翻译**：那个方向的调用方是
 * 我们自己的服务而不是 Claude Code，需求尚未出现，凭空造一层无人验证的映射
 * 只会给出兑现不了的语义等价承诺。
 */
import type { CatalogProtocol } from '../catalog/types.js';
import { translateAnthropicRequest } from './anthropic-to-openai.js';
import { translateOpenAiCompletion } from './openai-to-anthropic.js';
import { translateOpenAiStreamToAnthropic } from './translate-stream.js';
import type { ProtocolTranslator } from './types.js';

export interface SelectTranslatorOptions {
  /** 翻译流的心跳间隔（毫秒）。0 = 关掉。默认见 `translate-stream.ts`。 */
  pingIntervalMs?: number;
}

/** Anthropic 调用方 → OpenAI 上游。 */
export function anthropicToOpenAiTranslator(
  opts: SelectTranslatorOptions = {}
): ProtocolTranslator {
  return {
    face: 'anthropic',
    upstream: 'openai',
    // 端点名不同，且刻意**不带调用方的 query**——`?beta=true` 是 Anthropic 专有的。
    upstreamPath: '/v1/chat/completions',
    translateRequest: (body, o) => translateAnthropicRequest(body, o),
    translateResponse: (raw, upstreamModel) => translateOpenAiCompletion(raw, upstreamModel),
    translateStream: (upstream, upstreamModel) =>
      translateOpenAiStreamToAnthropic(upstream, {
        fallbackModel: upstreamModel,
        pingIntervalMs: opts.pingIntervalMs,
      }),
  };
}

/**
 * 按「调用方协议面 × 上游协议」挑翻译器。
 *
 * 同协议返回 null（调用方本就该走 passthrough / rewrite-model，不该到这儿来）。
 */
export function selectTranslator(
  face: CatalogProtocol,
  upstream: CatalogProtocol,
  opts: SelectTranslatorOptions = {}
): ProtocolTranslator | null {
  if (face === upstream) return null;
  if (face === 'anthropic' && upstream === 'openai') return anthropicToOpenAiTranslator(opts);
  return null;
}
