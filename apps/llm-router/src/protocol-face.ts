/**
 * 「对外协议面」的判定（M4·T4.5 / T4.6）。
 *
 * 网关同时暴露 Anthropic 与 OpenAI 两个协议面（D2）。**面**决定错误体的形状，
 * **上游 provider 的 protocol** 决定用哪个 usage 解析器；两者不同时才需要 translate
 * （T4.7，只交付 Anthropic 面 → OpenAI 上游一个方向，见 `selectTranslator`）。
 *
 * 判定按 **path**：Claude Code 实际请求的是 `/v1/messages?beta=true`，
 * 匹配完整 URL 会直接漏掉它。
 */
import type { CatalogProtocol } from '@open-rush/llm-router';

const OPENAI_PATHS = new Set(['/v1/chat/completions', '/v1/completions', '/v1/embeddings']);

export function faceProtocolOf(pathname: string): CatalogProtocol {
  return OPENAI_PATHS.has(pathname) ? 'openai' : 'anthropic';
}
