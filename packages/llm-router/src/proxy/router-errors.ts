/**
 * 网关**自身**错误的信封与错误码（M4，R5 §6.2，D10）。
 *
 * D10 的三套错误信封里，这里只负责第二套——「网关错误按调用方协议成形」。
 * 另外两套：
 *  - **上游错误体原样透传**，一个字节都不包（见 `forward.ts`）。Claude Code 的
 *    能力降级重试按上游错误文案匹配，包一层信封会直接打断它的恢复路径。
 *  - 控制台 API 用仓库既有的 v1 信封（`apps/web` 侧，与本文件无关）。
 *
 * 一个 kind 同时定死四件事：HTTP 状态码、Anthropic 面的 `error.type`、
 * OpenAI 面的 `error.code`、以及记进 `llm_calls.status` 的值。这样 R5 §6.2 那张
 * 表就有了唯一的落点，单测直接照着表逐行断言。
 */
import type { CatalogProtocol } from '../catalog/types.js';

export type RouterErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'model_not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'upstream_error'
  | 'internal_error';

/** 与 `packages/contracts` 的 `llmCallStatusSchema` 取值一致（此处不 import 以免库层耦合 zod）。 */
export type CallStatus =
  | 'success'
  | 'upstream_error'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'client_abort'
  | 'router_error'
  | 'unauthorized'
  | 'forbidden'
  | 'model_not_found';

export interface RouterErrorSpec {
  httpStatus: number;
  anthropicType: string;
  openaiCode: string;
  callStatus: CallStatus;
}

/** R5 §6.2 的表，逐行落成常量。 */
export const ROUTER_ERRORS: Readonly<Record<RouterErrorKind, RouterErrorSpec>> = {
  unauthorized: {
    httpStatus: 401,
    anthropicType: 'authentication_error',
    openaiCode: 'invalid_api_key',
    callStatus: 'unauthorized',
  },
  forbidden: {
    httpStatus: 403,
    anthropicType: 'permission_error',
    openaiCode: 'insufficient_permissions',
    callStatus: 'forbidden',
  },
  model_not_found: {
    httpStatus: 404,
    anthropicType: 'not_found_error',
    openaiCode: 'model_not_found',
    callStatus: 'model_not_found',
  },
  invalid_request: {
    httpStatus: 400,
    anthropicType: 'invalid_request_error',
    openaiCode: 'invalid_request_error',
    callStatus: 'router_error',
  },
  rate_limited: {
    httpStatus: 429,
    anthropicType: 'rate_limit_error',
    openaiCode: 'rate_limit_exceeded',
    callStatus: 'rate_limited',
  },
  budget_exceeded: {
    httpStatus: 429,
    anthropicType: 'rate_limit_error',
    openaiCode: 'rate_limit_exceeded',
    callStatus: 'budget_exceeded',
  },
  upstream_error: {
    httpStatus: 502,
    anthropicType: 'api_error',
    openaiCode: 'upstream_error',
    callStatus: 'upstream_error',
  },
  internal_error: {
    httpStatus: 500,
    anthropicType: 'api_error',
    openaiCode: 'internal_error',
    callStatus: 'router_error',
  },
};

export interface RouterErrorOptions {
  /** 429 一律带 `Retry-After`（秒）。 */
  retryAfterSec?: number;
  requestId?: string;
}

/** 按调用方协议成形的错误体。两种形状都用各自生态里客户端认得的字段名。 */
export function routerErrorBody(
  protocol: CatalogProtocol,
  kind: RouterErrorKind,
  message: string
): Record<string, unknown> {
  const spec = ROUTER_ERRORS[kind];
  return protocol === 'openai'
    ? { error: { message, type: spec.openaiCode, code: spec.openaiCode, param: null } }
    : { type: 'error', error: { type: spec.anthropicType, message } };
}

/**
 * 生成一个网关错误响应。
 *
 * ⚠️ `message` 里**绝不能**出现 baseUrl、密文、明文密钥或目录中其他模型的名字
 * （A9 / A10 / 枚举泄露）。调用点只拼供应商的 `name` 与被请求的 alias。
 */
export function routerErrorResponse(
  protocol: CatalogProtocol,
  kind: RouterErrorKind,
  message: string,
  opts: RouterErrorOptions = {}
): Response {
  const spec = ROUTER_ERRORS[kind];
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.retryAfterSec !== undefined) {
    headers.set('retry-after', String(Math.max(0, Math.ceil(opts.retryAfterSec))));
  }
  if (opts.requestId) headers.set('x-request-id', opts.requestId);
  return new Response(JSON.stringify(routerErrorBody(protocol, kind, message)), {
    status: spec.httpStatus,
    headers,
  });
}
