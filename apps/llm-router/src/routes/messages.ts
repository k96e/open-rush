/**
 * Anthropic 面：`/v1/messages` 与 `/v1/messages/count_tokens`（M4·T4.5）。
 *
 * 两条都**按 path 匹配**——Claude Code 实际请求的是 `/v1/messages?beta=true`，
 * query 原样带给上游，不参与匹配。
 */
import { Hono } from 'hono';
import type { RouterDeps, RouterEnv } from '../deps.js';
import { handleInference } from './inference.js';

export function messagesRoutes(deps: RouterDeps): Hono<RouterEnv> {
  const app = new Hono<RouterEnv>();

  app.post('/messages', (c) => handleInference(c, deps, { face: 'anthropic', allowStream: true }));

  /**
   * token 计数。官方标注可选，但不实现会让 Claude Code 改用一次真实推理去估算
   * 上下文——那才是真的浪费额度。它永远不是流式的。
   */
  app.post('/messages/count_tokens', (c) =>
    handleInference(c, deps, { face: 'anthropic', allowStream: false })
  );

  return app;
}
