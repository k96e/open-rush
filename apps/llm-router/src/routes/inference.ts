/**
 * 两个协议面共用的推理管线（M4·T4.5 / T4.6）。
 *
 * 顺序是固定的：**认证（中间件） → 解析 → 令牌白名单 → 路由 → 改写 → 转发**。
 * 每一步的失败都按 R5 §6.2 成形，并（在有 subject 之后）落一条 `llm_calls`——
 * 「403 / 404 / 400 也要计量」是 A5 对账的前提：只记成功调用的话，一个被拒的
 * 令牌在报表里会完全隐身。
 *
 * 这一层**不做任何提示词加工**（绝对边界）：除 `$.model` 与 OpenAI 流式的
 * `stream_options.include_usage` 外，请求体一个字节都不动。
 */
import {
  type CallRecord,
  type CatalogProtocol,
  type CatalogRouteMode,
  forward,
  injectStreamIncludeUsage,
  isAliasAllowed,
  isRouteError,
  ModelRewriteError,
  type ResolvedRoute,
  ROUTER_ERRORS,
  type RouterErrorKind,
  resolveRoute,
  rewriteModelField,
  routerErrorResponse,
  type Subject,
} from '@open-rush/llm-router';
import type { Context } from 'hono';
import type { RouterDeps, RouterEnv } from '../deps.js';

const DECODER = new TextDecoder();

export interface InferenceOptions {
  /** 对外协议面。决定错误体形状，也决定能路由到哪种上游（跨协议要 T4.7）。 */
  face: CatalogProtocol;
  /** `count_tokens` 之类不产生流的端点传 false：即使 body 里写了 stream 也走缓冲分支。 */
  allowStream: boolean;
  /**
   * OpenAI 流式需要注入 `stream_options.include_usage` 才拿得到 usage。
   * 只有 `/v1/chat/completions` 打开。
   */
  injectUsageOnStream?: boolean;
}

interface RejectionInput {
  c: Context<RouterEnv>;
  deps: RouterDeps;
  face: CatalogProtocol;
  kind: RouterErrorKind;
  message: string;
  alias: string | null;
  stream: boolean;
  errorCode: string;
  route?: ResolvedRoute;
  startedAt: Date;
  t0: number;
}

/**
 * 拒绝路径的统一出口：**先记一条 `llm_calls`，再返回错误体**。
 *
 * 归属全部来自 subject（D6）；`cc_*` 分组提示来自请求头，可伪造，只用于下钻。
 */
function reject(input: RejectionInput): Response {
  const { c, deps, face, kind, message, alias, route } = input;
  const subject = c.get('subject') as Subject | undefined;
  const spec = ROUTER_ERRORS[kind];

  if (subject) {
    const record: CallRecord = {
      requestId: c.get('requestId') ?? null,
      tokenId: subject.tokenId,
      subjectType: subject.subjectType,
      runId: subject.runId,
      agentId: subject.agentId,
      projectId: subject.projectId,
      ownerUserId: subject.ownerUserId,
      ccSessionId: c.req.header('x-claude-code-session-id') ?? null,
      ccAgentId: c.req.header('x-claude-code-agent-id') ?? null,
      // body 都没解析出来时没有 alias 可记。列是 NOT NULL，用空串而不是造一个
      // 假名字——报表里一眼能看出「这次调用连模型都没说清」。
      modelAlias: alias ?? '',
      providerId: route?.provider.id ?? null,
      upstreamModel: route?.model.upstreamModel ?? null,
      protocol: route?.provider.protocol ?? face,
      mode: route?.mode ?? 'passthrough',
      stream: input.stream,
      status: spec.callStatus,
      httpStatus: spec.httpStatus,
      errorCode: input.errorCode,
      tokensIn: 0,
      tokensCacheWrite: 0,
      tokensCacheRead: 0,
      tokensOut: 0,
      tokensReasoning: 0,
      costUsd: '0.000000',
      ttfbMs: null,
      latencyMs: Math.round(performance.now() - input.t0),
      startedAt: input.startedAt,
      completedAt: new Date(),
    };
    try {
      deps.recorder.enqueue(record);
    } catch (err) {
      // A5：计量失败不阻塞上层调用。
      deps.logger?.warn({ err: String(err) }, 'failed to record rejected call');
    }
  }

  return routerErrorResponse(face, kind, message, { requestId: c.get('requestId') });
}

export async function handleInference(
  c: Context<RouterEnv>,
  deps: RouterDeps,
  opts: InferenceOptions
): Promise<Response> {
  const startedAt = new Date();
  const t0 = performance.now();
  const { face } = opts;
  const subject = c.get('subject');

  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());

  // ① 解析。只为了拿 model / stream 两个字段——**原始字节继续用于转发**。
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(DECODER.decode(bodyBytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return reject({
      c,
      deps,
      face,
      kind: 'invalid_request',
      message: 'request body must be a JSON object',
      alias: null,
      stream: false,
      errorCode: 'INVALID_JSON',
      startedAt,
      t0,
    });
  }

  const alias = typeof payload.model === 'string' ? payload.model.trim() : '';
  const stream = opts.allowStream && payload.stream === true;

  if (!alias) {
    return reject({
      c,
      deps,
      face,
      kind: 'invalid_request',
      message: "field 'model' is required",
      alias: null,
      stream,
      errorCode: 'MISSING_MODEL',
      startedAt,
      t0,
    });
  }

  // ② 令牌白名单。**在路由之前**判：令牌不允许的 alias，连它存不存在都不该泄露。
  if (!isAliasAllowed(subject, alias)) {
    return reject({
      c,
      deps,
      face,
      kind: 'forbidden',
      message: `model '${alias}' is not allowed for this token`,
      alias,
      stream,
      errorCode: 'ALIAS_NOT_ALLOWED',
      startedAt,
      t0,
    });
  }

  // ③ 路由。快照没加载完就当作内部错误——`readyz` 本该已经把流量摘走了。
  const snapshot = deps.catalog.current;
  if (!snapshot) {
    return reject({
      c,
      deps,
      face,
      kind: 'internal_error',
      message: 'router catalog is not loaded yet',
      alias,
      stream,
      errorCode: 'CATALOG_NOT_LOADED',
      startedAt,
      t0,
    });
  }

  const resolved = resolveRoute(snapshot, alias);
  if (isRouteError(resolved)) {
    // 错误体只回显被请求的 alias，不枚举目录（枚举泄露）。
    return reject({
      c,
      deps,
      face,
      kind: 'model_not_found',
      message: `model '${alias}' not found`,
      alias,
      stream,
      errorCode: 'MODEL_NOT_FOUND',
      startedAt,
      t0,
    });
  }

  // ④ 跨协议：M4 只做同协议转发，跨协议的 translate 是 T4.7（Stretch）。
  //    这里当作「这个面上没有这个模型」而不是 500——对调用方来说事实就是如此，
  //    而且错误体里不必解释目录的内部结构。
  if (resolved.provider.protocol !== face) {
    return reject({
      c,
      deps,
      face,
      kind: 'model_not_found',
      message: `model '${alias}' is not available on this protocol endpoint`,
      alias,
      stream,
      route: resolved,
      errorCode: 'PROTOCOL_FACE_MISMATCH',
      startedAt,
      t0,
    });
  }

  // ⑤ 改写。passthrough 时 outBody 与 bodyBytes 是同一个引用（A1 第一档承诺）。
  let outBody: Uint8Array = bodyBytes;
  let mode: CatalogRouteMode = resolved.mode;
  if (resolved.mode === 'rewrite-model') {
    try {
      outBody = rewriteModelField(bodyBytes, resolved.model.upstreamModel);
    } catch (err) {
      if (!(err instanceof ModelRewriteError)) throw err;
      return reject({
        c,
        deps,
        face,
        kind: 'invalid_request',
        message: 'request body must be a JSON object',
        alias,
        stream,
        route: resolved,
        errorCode: 'INVALID_JSON',
        startedAt,
        t0,
      });
    }
  }

  if (opts.injectUsageOnStream && stream) {
    const injected = injectStreamIncludeUsage(outBody);
    outBody = injected.body;
    if (injected.injected) mode = 'rewrite-model';
  }

  // ⑥ 转发。path 含 query（`/v1/messages?beta=true` 必须原样带过去）。
  const url = new URL(c.req.url);
  return forward({
    route: resolved,
    body: outBody,
    upstreamPath: `${url.pathname}${url.search}`,
    inboundHeaders: c.req.raw.headers,
    isStream: stream,
    mode,
    subject,
    requestId: c.get('requestId') ?? '',
    privateKeyPem: deps.privateKeyPem,
    recorder: deps.recorder,
    signal: c.req.raw.signal,
  });
}
