/**
 * 跨协议翻译的公共类型（M4·T4.7）。
 *
 * `translate` 是 A1 三档承诺里的**第三档**：它**不承诺字节一致**，只承诺
 * 「语义等价 + 流式事件不丢不改序」。这一档存在的唯一理由是让 Anthropic 协议的
 * 调用方（Claude Code）能打到 OpenAI 兼容的上游；同协议的两档（passthrough /
 * rewrite-model）一个字节都不会经过这里。
 *
 * ⚠️ 与同协议路径相反，翻译路径用的是**封闭映射**（allowlist）而不是开放列表：
 * Anthropic 独有的字段（`thinking` / `context_management` / `output_config` /
 * `cache_control` / `mcp_servers` …）送给 OpenAI 上游只会换来 400。开放列表的规矩
 * 是给「Anthropic → Anthropic」用的，跨协议时必须反过来。
 */
import type { CatalogProtocol } from '../catalog/types.js';

/** 请求无法翻译（不是合法的 Anthropic Messages 请求）。路由层据此回 400。 */
export class ProtocolTranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolTranslateError';
  }
}

export interface TranslateRequestOptions {
  /** 上游真实模型名。跨协议时 `$.model` 必然要改，这不是 rewrite-model 的例外。 */
  upstreamModel: string;
  /** 调用方是否要流式。为 true 时会同时打开上游的 `stream_options.include_usage`。 */
  stream: boolean;
}

/**
 * 一个方向的协议翻译器。
 *
 * 目前只有 `anthropic → openai` 一个实现（见 `anthropic-openai.ts`）。反方向
 * （OpenAI 面的调用方 → Anthropic 上游）**不在本次交付内**，`selectTranslator`
 * 对它返回 null，路由层维持 404 + `PROTOCOL_FACE_MISMATCH`。
 */
export interface ProtocolTranslator {
  /** 调用方协议面。 */
  readonly face: CatalogProtocol;
  /** 上游协议。 */
  readonly upstream: CatalogProtocol;
  /**
   * 上游的相对路径。跨协议时端点名不同（`/v1/messages` → `/v1/chat/completions`），
   * 且**不带调用方的 query**——`?beta=true` 是 Anthropic 专有的。
   */
  readonly upstreamPath: string;
  /** 翻请求。非法输入抛 {@link ProtocolTranslateError}。 */
  translateRequest(body: Uint8Array, opts: TranslateRequestOptions): Uint8Array;
  /**
   * 翻非流式响应。**翻不动时返回 null**（不抛）——转发路径据此回 502，
   * 而不是把一份上游形状的 body 冒充成调用方协议的响应。
   */
  translateResponse(raw: Uint8Array, upstreamModel: string): Uint8Array | null;
  /** 翻流式响应。入参是上游原始字节流，出参是调用方协议的 SSE 流。 */
  translateStream(
    upstream: ReadableStream<Uint8Array>,
    upstreamModel: string
  ): ReadableStream<Uint8Array>;
}
