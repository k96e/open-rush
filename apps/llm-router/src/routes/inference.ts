/**
 * 两个协议面共用的推理管线（M4·T4.5 / T4.6）。
 *
 * 顺序是固定的：**认证（中间件） → 限流（中间件） → 解析 → 令牌白名单 → 路由 →
 * 预算 → 改写 → 转发**。每一步的失败都按 R5 §6.2 成形，并（在有 subject 之后）
 * 落一条 `llm_calls`（见 `../reject.ts`）。
 *
 * 预算闸门放在路由**之后**：这样被拦下的那条 `llm_calls` 带得上 alias 与 provider，
 * 报表里能看出「是哪个模型把额度花光的」。限流则相反，坐在中间件里、body 都不解析
 * ——它的职责是尽早卸载，多解析一次 body 就是多一份被打满时的开销。
 *
 * 这一层**不做任何提示词加工**（绝对边界）：除 `$.model` 与 OpenAI 流式的
 * `stream_options.include_usage` 外，请求体一个字节都不动。
 */
import {
  type BudgetDecision,
  type CatalogProtocol,
  type CatalogRouteMode,
  forward,
  injectStreamIncludeUsage,
  isAliasAllowed,
  isRouteError,
  ModelRewriteError,
  resolveRoute,
  rewriteModelField,
} from '@open-rush/llm-router';
import type { Context } from 'hono';
import type { RouterDeps, RouterEnv } from '../deps.js';
import { reject } from '../reject.js';

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

  // ⑤ 预算闸门。未装配（deps.budget 为空）= 开关关闭，与限流开关互相独立（A6）。
  //    observe 档在 BudgetService 内部就放行了，走到这里的一定是 enforce 且已超限。
  if (deps.budget) {
    let decision: BudgetDecision | null = null;
    try {
      decision = await deps.budget.check(subject);
    } catch (err) {
      // 闸门自己炸了不能连累转发（可用性优先，与 Redis 不可达时的降级同理）。
      deps.logger?.warn({ err: String(err) }, 'budget check failed, allowing request');
    }
    if (decision && !decision.allowed) {
      return reject({
        c,
        deps,
        face,
        kind: 'budget_exceeded',
        message: decision.reason,
        alias,
        stream,
        route: resolved,
        errorCode: 'BUDGET_EXCEEDED',
        retryAfterSec: decision.retryAfterSec,
        startedAt,
        t0,
      });
    }
  }

  // ⑥ 改写。passthrough 时 outBody 与 bodyBytes 是同一个引用（A1 第一档承诺）。
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

  // ⑦ 转发。path 含 query（`/v1/messages?beta=true` 必须原样带过去）。
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
