/**
 * 一次上游转发的完整生命周期（M4·T4.3，C4 §7.8）。
 *
 * 设计约束（每一条都有对应的单测）：
 *  - 请求 body 以 `Uint8Array` **原样**发出；passthrough 模式下与收到的字节完全相同（A1）；
 *  - 响应流不落地、不缓冲、不改分块（A1 + Claude Code 的 300s 字节看门狗）；
 *  - 上游错误体**原样透传**，状态码照抄，不包信封（D10）；
 *  - 上游不可达 → 502，且错误体只含供应商的 **name**，不含 baseUrl、不含密钥（A10）；
 *  - 计量全程在旁路，任何失败都不影响返回值（A5）。
 *
 * 密钥边界：解封出来的明文只活在本函数的栈上，不进任何长生命周期结构、
 * 不进日志、不进错误信息（A11）。
 */

import type { ProtocolTranslator } from '../adapters/types.js';
import type { Subject } from '../auth/token-store.js';
import type { CatalogProtocol, CatalogRouteMode, ResolvedRoute } from '../catalog/types.js';
import { openSealed } from '../crypto/sealed-box.js';
import type { CallRecord, CallRecorder } from '../metering/call-record.js';
import { AnthropicSseUsageParser } from '../usage/anthropic-parser.js';
import { computeCostUsd } from '../usage/cost.js';
import { OpenAiSseUsageParser } from '../usage/openai-parser.js';
import type { UsageParser } from '../usage/types.js';
import { buildUpstreamHeaders, extractGroupingHints, stripHopByHop } from './headers.js';
import { type CallStatus, routerErrorResponse } from './router-errors.js';
import { teeForMetering } from './sse-tee.js';

export interface ForwardInput {
  route: ResolvedRoute;
  /** 原始请求字节；rewrite-model 模式下已由 `model-rewrite.ts` 重建。 */
  body: Uint8Array;
  /** 上游相对路径，**含 query**，如 `/v1/messages?beta=true`。 */
  upstreamPath: string;
  inboundHeaders: Headers;
  isStream: boolean;
  /** 记进 `llm_calls.mode`。与 `route.mode` 可能不同（如 T4.6 注入 stream_options）。 */
  mode: CatalogRouteMode | 'translate';
  /**
   * 调用方的协议面。**网关自身错误按它成形**（R5 §6.2），跨协议时它与
   * `route.provider.protocol` 不同——用错了会把 OpenAI 形状的错误体发给
   * Anthropic 客户端。不传则退化成上游协议（同协议时两者本就相等）。
   */
  face?: CatalogProtocol;
  /**
   * 跨协议翻译器（M4·T4.7）。不传 = 同协议直转，请求与响应都不重新编码。
   *
   * 传了也**只对 2xx 生效**：上游错误体一律原样透传，不翻译、不包信封——
   * Claude Code 的能力降级重试按上游错误文案匹配（D10）。
   */
  translator?: ProtocolTranslator;
  subject: Subject;
  requestId: string;
  privateKeyPem: string;
  recorder: CallRecorder;
  /** 调用方断开时触发；与 provider 的超时取「先到者」。 */
  signal: AbortSignal;
}

function makeParser(protocol: ResolvedRoute['provider']['protocol']): UsageParser {
  return protocol === 'openai' ? new OpenAiSseUsageParser() : new AnthropicSseUsageParser();
}

/** fetch 失败的分类。只用于 `llm_calls.error_code`，**不回显给调用方**。 */
export function classifyFetchError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return 'UPSTREAM_TIMEOUT';
  if (name === 'AbortError') return 'CLIENT_ABORT';
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code ? `UPSTREAM_${code}` : 'UPSTREAM_FETCH_FAILED';
}

interface RecordSeed {
  status: CallStatus;
  httpStatus: number | null;
  errorCode: string | null;
  ttfbMs: number | null;
}

function baseRecord(
  input: ForwardInput,
  startedAt: Date,
  t0: number,
  seed: RecordSeed
): CallRecord {
  const { ccSessionId, ccAgentId } = extractGroupingHints(input.inboundHeaders);
  return {
    requestId: input.requestId,
    tokenId: input.subject.tokenId,
    subjectType: input.subject.subjectType,
    runId: input.subject.runId,
    agentId: input.subject.agentId,
    projectId: input.subject.projectId,
    ownerUserId: input.subject.ownerUserId,
    ccSessionId,
    ccAgentId,
    modelAlias: input.route.model.alias,
    providerId: input.route.provider.id,
    upstreamModel: input.route.model.upstreamModel,
    protocol: input.route.provider.protocol,
    mode: input.mode,
    stream: input.isStream,
    status: seed.status,
    httpStatus: seed.httpStatus,
    errorCode: seed.errorCode,
    tokensIn: 0,
    tokensCacheWrite: 0,
    tokensCacheRead: 0,
    tokensOut: 0,
    tokensReasoning: 0,
    costUsd: '0.000000',
    ttfbMs: seed.ttfbMs,
    latencyMs: Math.round(performance.now() - t0),
    startedAt,
    completedAt: new Date(),
  };
}

export async function forward(input: ForwardInput): Promise<Response> {
  const { route, translator } = input;
  const face = input.face ?? route.provider.protocol;
  const startedAt = new Date();
  const t0 = performance.now();

  /**
   * A5「计量失败不阻塞上层调用」在这里落成机制而不是约定：即便注入进来的
   * recorder 实现违约抛了错，转发路径也照常返回。
   */
  const recorder = {
    enqueue(record: CallRecord): void {
      try {
        input.recorder.enqueue(record);
      } catch {
        // 旁路失败不影响主链路。
      }
    },
  };

  // ① 解封密钥。明文只活在这个函数的栈上。
  let apiKey: string | null = null;
  if (route.credential) {
    try {
      apiKey = openSealed(input.privateKeyPem, {
        alg: route.credential.alg,
        keyId: route.credential.keyId,
        value: route.credential.sealedValue,
      });
    } catch {
      // 指纹不匹配 / 密文损坏。**绝不回显任何密文片段**，也不回显解封异常原文
      // ——那里面带着 keyId 与长度信息。
      recorder.enqueue(
        baseRecord(input, startedAt, t0, {
          status: 'router_error',
          httpStatus: 500,
          errorCode: 'CREDENTIAL_UNSEALABLE',
          ttfbMs: null,
        })
      );
      return routerErrorResponse(
        face,
        'internal_error',
        `credential '${route.credential.name}' cannot be unsealed by this router instance`,
        { requestId: input.requestId }
      );
    }
  }

  const url = `${route.provider.baseUrl.replace(/\/+$/, '')}${input.upstreamPath}`;
  const headers = buildUpstreamHeaders(input.inboundHeaders, route, apiKey, input.requestId, {
    crossProtocol: translator !== undefined,
  });
  apiKey = null; // 尽快断开引用；Headers 里那一份随请求结束一起走。

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: input.body, // ← 原始字节
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(route.provider.timeoutMs)]),
    });
  } catch (err) {
    const errorCode = classifyFetchError(err);
    const aborted = input.signal.aborted;
    recorder.enqueue(
      baseRecord(input, startedAt, t0, {
        status: aborted ? 'client_abort' : 'upstream_error',
        httpStatus: aborted ? null : 502,
        errorCode,
        ttfbMs: null,
      })
    );
    // A10：明确 502，错误信息只含供应商**名字**——不含 baseUrl、不含任何密钥。
    return routerErrorResponse(
      face,
      'upstream_error',
      `provider '${route.provider.name}' is unavailable`,
      { requestId: input.requestId }
    );
  }

  const responseHeaders = stripHopByHop(upstream.headers);
  const ttfbMs = Math.round(performance.now() - t0);
  const parser = makeParser(route.provider.protocol);

  const finish = (httpStatus: number, abortReason?: unknown): void => {
    const usage = parser.result();
    // 流被中断有两种原因，记成同一种会让「客户端老是断开」和「上游老是断流」
    // 在报表里分不开：看调用方的 signal 是不是真的取消了。
    const interrupted = abortReason !== undefined;
    const byClient = interrupted && input.signal.aborted;
    const record = baseRecord(input, startedAt, t0, {
      status: byClient
        ? 'client_abort'
        : interrupted || httpStatus >= 400
          ? 'upstream_error'
          : 'success',
      httpStatus,
      errorCode: interrupted
        ? byClient
          ? 'CLIENT_ABORT'
          : 'UPSTREAM_STREAM_INTERRUPTED'
        : httpStatus >= 400
          ? `UPSTREAM_HTTP_${httpStatus}`
          : null,
      ttfbMs,
    });
    record.upstreamModel = usage.upstreamModel ?? record.upstreamModel;
    record.tokensIn = usage.tokensIn;
    record.tokensCacheWrite = usage.tokensCacheWrite;
    record.tokensCacheRead = usage.tokensCacheRead;
    record.tokensOut = usage.tokensOut;
    record.tokensReasoning = usage.tokensReasoning;
    record.costUsd = computeCostUsd(usage, route.model);
    recorder.enqueue(record);
  };

  /**
   * 翻译**只对 2xx 生效**。上游 4xx/5xx 的 body 一个字节都不动（D10）——
   * Claude Code 按上游错误文案做能力降级重试，翻一遍就等于换了文案。
   */
  const translating = translator !== undefined && upstream.status < 400;

  // ② 非流式：读完整 body → 解析副本 → 返回（同协议是同一份字节，跨协议是翻译后的）。
  //    上游非 2xx 也走这里，状态码与 body 一并照抄（D10）。
  if (!input.isStream || !upstream.body) {
    const raw = new Uint8Array(await upstream.arrayBuffer());
    try {
      parser.pushNonStreamBody(raw);
    } catch {
      // 旁路失败不影响返回。
    }
    let out: Uint8Array = raw;
    if (translating) {
      const translated = translator.translateResponse(raw, route.model.upstreamModel);
      if (translated === null) {
        // 上游回了 2xx 但不是能认的形状。宁可 502，也不要把上游形状的 body
        // 冒充成调用方协议的响应——那会让客户端在解析处炸得莫名其妙。
        recorder.enqueue(
          baseRecord(input, startedAt, t0, {
            status: 'upstream_error',
            httpStatus: 502,
            errorCode: 'UPSTREAM_UNTRANSLATABLE',
            ttfbMs,
          })
        );
        return routerErrorResponse(
          face,
          'upstream_error',
          `provider '${route.provider.name}' returned a response this router cannot translate`,
          { requestId: input.requestId }
        );
      }
      out = translated;
    }
    finish(upstream.status);
    return new Response(out, { status: upstream.status, headers: responseHeaders });
  }

  // ③ 流式：tee 转发。上游非 2xx 时同样原样透传（D10）。
  //    **计量在翻译之前**——账要按上游真实回了什么来记，而不是按翻译产物。
  const teed = teeForMetering(upstream.body, {
    onChunk: (chunk) => parser.push(chunk),
    onEnd: (reason) => finish(upstream.status, reason),
  });
  const body = translating ? translator.translateStream(teed, route.model.upstreamModel) : teed;
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}
