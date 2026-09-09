import { describe, expect, it } from 'vitest';
import {
  ROUTER_ERRORS,
  type RouterErrorKind,
  routerErrorBody,
  routerErrorResponse,
} from '../router-errors.js';

/** R5 §6.2 的表，逐行钉死。 */
const TABLE: Array<[RouterErrorKind, number, string, string, string]> = [
  ['unauthorized', 401, 'authentication_error', 'invalid_api_key', 'unauthorized'],
  ['forbidden', 403, 'permission_error', 'insufficient_permissions', 'forbidden'],
  ['model_not_found', 404, 'not_found_error', 'model_not_found', 'model_not_found'],
  ['invalid_request', 400, 'invalid_request_error', 'invalid_request_error', 'router_error'],
  ['rate_limited', 429, 'rate_limit_error', 'rate_limit_exceeded', 'rate_limited'],
  ['budget_exceeded', 429, 'rate_limit_error', 'rate_limit_exceeded', 'budget_exceeded'],
  ['upstream_error', 502, 'api_error', 'upstream_error', 'upstream_error'],
  ['internal_error', 500, 'api_error', 'internal_error', 'router_error'],
];

describe('ROUTER_ERRORS 与 R5 §6.2 一致', () => {
  it.each(TABLE)('%s → %i / %s / %s / %s', (kind, http, anthropic, openai, callStatus) => {
    expect(ROUTER_ERRORS[kind]).toEqual({
      httpStatus: http,
      anthropicType: anthropic,
      openaiCode: openai,
      callStatus,
    });
  });

  it('八个 kind 一个不多一个不少', () => {
    expect(Object.keys(ROUTER_ERRORS).sort()).toEqual(TABLE.map(([k]) => k).sort());
  });
});

describe('routerErrorBody', () => {
  it('Anthropic 面用 { type: "error", error: { type, message } }', () => {
    expect(routerErrorBody('anthropic', 'rate_limited', 'budget exceeded')).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'budget exceeded' },
    });
  });

  it('OpenAI 面用 { error: { message, type, code, param } }', () => {
    expect(routerErrorBody('openai', 'model_not_found', "model 'x' not found")).toEqual({
      error: {
        message: "model 'x' not found",
        type: 'model_not_found',
        code: 'model_not_found',
        param: null,
      },
    });
  });
});

describe('routerErrorResponse', () => {
  it('状态码与 content-type', async () => {
    const res = routerErrorResponse('anthropic', 'unauthorized', 'missing token');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json');
    await expect(res.json()).resolves.toMatchObject({
      error: { type: 'authentication_error' },
    });
  });

  it('429 带 Retry-After（向上取整）', () => {
    const res = routerErrorResponse('anthropic', 'rate_limited', 'slow down', {
      retryAfterSec: 3.2,
    });
    expect(res.headers.get('retry-after')).toBe('4');
  });

  it('负数的 Retry-After 收敛到 0', () => {
    const res = routerErrorResponse('openai', 'budget_exceeded', 'over', { retryAfterSec: -5 });
    expect(res.headers.get('retry-after')).toBe('0');
  });

  it('非 429 不带 Retry-After', () => {
    expect(
      routerErrorResponse('anthropic', 'upstream_error', 'x').headers.get('retry-after')
    ).toBeNull();
  });

  it('带上 x-request-id 便于两侧日志对齐', () => {
    expect(
      routerErrorResponse('anthropic', 'internal_error', 'x', { requestId: 'req-9' }).headers.get(
        'x-request-id'
      )
    ).toBe('req-9');
  });
});
