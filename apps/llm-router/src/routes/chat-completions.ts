/**
 * OpenAI 面：`/v1/chat/completions`（M4·T4.6）。
 *
 * 与 Anthropic 面唯一的结构性差异是 `injectUsageOnStream`：OpenAI 兼容协议下，
 * 流式响应只有在请求带了 `stream_options.include_usage=true` 时才回 usage。
 * 网关会替调用方补上这一个键（调用方自己写过就不动），并把该次调用的
 * `llm_calls.mode` 记为 `rewrite-model`——这条取舍要写进验收报告的 A1 / F2 栏。
 */
import { Hono } from 'hono';
import type { RouterDeps, RouterEnv } from '../deps.js';
import { handleInference } from './inference.js';

export function chatCompletionsRoutes(deps: RouterDeps): Hono<RouterEnv> {
  const app = new Hono<RouterEnv>();

  app.post('/chat/completions', (c) =>
    handleInference(c, deps, {
      face: 'openai',
      allowStream: true,
      injectUsageOnStream: true,
      // 反方向（OpenAI 面 → Anthropic 上游）本次未交付，`selectTranslator` 也会
      // 返回 null；这里写明白，免得后来者以为是漏配。
      allowTranslate: true,
    })
  );

  return app;
}
