/**
 * 令牌认证中间件（M4·T4.2）。
 *
 * D12「没有钥匙就没有门」：业务面每一条路由都挂它，包括 `/v1/models`——
 * 模型目录也是运营信息，不该对任何拿得到网关地址的人开放。
 *
 * 401 的错误体按**调用方协议**成形（R5 §6.2）：走 `/v1/chat/completions` 的
 * 客户端认的是 OpenAI 形状，回 Anthropic 形状它读不懂。
 *
 * ⚠️ 401 **不写 `llm_calls`**：这时候还没有 subject，`llm_calls` 的归属列
 * （subject_type / run / project）无从填起，硬造一行只会污染对账。未认证的访问
 * 属于访问日志的范畴，不属于计量。
 */
import { routerErrorResponse } from '@open-rush/llm-router';
import type { MiddlewareHandler } from 'hono';
import type { RouterEnv, SubjectAuthenticator } from '../deps.js';
import { faceProtocolOf } from '../protocol-face.js';

export function authenticate(authenticator: SubjectAuthenticator): MiddlewareHandler<RouterEnv> {
  return async (c, next) => {
    const subject = await authenticator.authenticate(c.req.raw.headers);
    if (!subject) {
      return routerErrorResponse(
        faceProtocolOf(new URL(c.req.url).pathname),
        'unauthorized',
        'missing or invalid router token',
        { requestId: c.get('requestId') }
      );
    }
    c.set('subject', subject);
    await next();
  };
}
