/**
 * 拒绝路径的统一出口（M4·T4.5 立在 `routes/inference.ts`，M5·T5.3 提到这里共用）。
 *
 * **先记一条 `llm_calls`，再返回错误体**：「403 / 404 / 400 / 429 也要计量」是 A5
 * 对账的前提——只记成功调用的话，一个被限流打满的令牌在报表里会完全隐身。
 *
 * 归属全部来自 subject（D6）；`cc_*` 分组提示来自请求头，可伪造，只用于下钻。
 */
import {
  type CallRecord,
  type CatalogProtocol,
  type ResolvedRoute,
  ROUTER_ERRORS,
  type RouterErrorKind,
  routerErrorResponse,
  type Subject,
} from '@open-rush/llm-router';
import type { Context } from 'hono';
import type { RouterDeps, RouterEnv } from './deps.js';

export interface RejectionInput {
  c: Context<RouterEnv>;
  deps: RouterDeps;
  face: CatalogProtocol;
  kind: RouterErrorKind;
  message: string;
  /** body 还没解析出来时为 null。 */
  alias: string | null;
  stream: boolean;
  errorCode: string;
  route?: ResolvedRoute;
  /** 429 专用。缺省由 `routerErrorResponse` 兜底成 60s。 */
  retryAfterSec?: number;
  startedAt: Date;
  t0: number;
}

export function reject(input: RejectionInput): Response {
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

  return routerErrorResponse(face, kind, message, {
    requestId: c.get('requestId'),
    retryAfterSec: input.retryAfterSec,
  });
}
