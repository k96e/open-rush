/**
 * 跨协议翻译在整条管线上的行为（M4·T4.7）。
 *
 * `packages/llm-router` 那边测的是映射本身；这里测的是**接线**：
 * 路由怎么挑翻译器、`llm_calls` 记成什么、开关关掉之后退回什么行为、
 * 哪些端点刻意不翻。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  type Harness,
  jsonResponder,
  makeModel,
  makeSnapshot,
  sseResponder,
} from '../../test/harness.js';

let harness: Harness;

/** 目录里只有一个 OpenAI 协议的 provider——即「Anthropic 面遇上 OpenAI 上游」。 */
function openAiUpstream(): void {
  harness.setSnapshot(
    makeSnapshot({
      models: [makeModel({ alias: 'my-alias', upstreamModel: 'gpt-4o' })],
      providers: [
        {
          id: 'prov-1',
          name: 'openai-prod',
          protocol: 'openai',
          baseUrl: harness.upstream.baseUrl,
          credentialId: 'cred-1',
          defaultHeaders: {},
          timeoutMs: 5_000,
        },
      ],
    })
  );
}

const post = (body: unknown, path = '/v1/messages'): Promise<Response> =>
  harness.fetch(path, { body: JSON.stringify(body) });

beforeEach(async () => {
  harness = await createHarness();
  openAiUpstream();
});
afterEach(async () => {
  await harness.close();
});

describe('POST /v1/messages → OpenAI 上游（translate）', () => {
  it('★ 端到端：Anthropic 请求进、Anthropic 响应出，中间走的是 OpenAI 协议', async () => {
    harness.upstream.setHandler(
      jsonResponder(
        200,
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 1 },
        })
      )
    );

    const res = await post({
      model: 'my-alias',
      max_tokens: 64,
      system: 'terse',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    });

    // 上游收到的是翻译后的 OpenAI 请求，端点也换了。
    const sent = JSON.parse(harness.upstream.requests[0].body.toString()) as Record<
      string,
      unknown
    >;
    expect(harness.upstream.requests[0].url).toBe('/v1/chat/completions');
    expect(sent.model).toBe('gpt-4o');
    expect(sent.messages).toEqual([
      { role: 'system', content: 'terse' },
      { role: 'user', content: 'hello' },
    ]);

    expect(harness.recorder.records[0]).toMatchObject({
      modelAlias: 'my-alias',
      upstreamModel: 'gpt-4o',
      protocol: 'openai',
      mode: 'translate',
      status: 'success',
      tokensIn: 8,
      tokensOut: 1,
    });
  });

  it('★ `?beta=true` 命中同一条路由，但 query 不带给 OpenAI 上游', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{"id":"c","model":"m","choices":[]}'));
    const res = await post({ model: 'my-alias', messages: [] }, '/v1/messages?beta=true');
    expect(res.status).toBe(200);
    expect(harness.upstream.requests[0].url).toBe('/v1/chat/completions');
  });

  it('流式：上游 OpenAI SSE → 调用方拿到 Anthropic 事件序列', async () => {
    harness.upstream.setHandler(
      sseResponder([
        'data: {"id":"c","model":"gpt-4o","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    const res = await post({ model: 'my-alias', messages: [], stream: true });
    const text = await res.text();

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
    expect(text).not.toContain('finish_reason');

    // 上游请求里必须带 include_usage，否则流式一条 usage 都拿不到。
    const sent = JSON.parse(harness.upstream.requests[0].body.toString()) as Record<
      string,
      unknown
    >;
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(harness.recorder.records[0]).toMatchObject({
      mode: 'translate',
      stream: true,
      tokensIn: 3,
      tokensOut: 2,
    });
  });

  it('上游错误体原样透传，不翻译、不包信封（D10）', async () => {
    const body = '{"error":{"message":"model_not_found","type":"invalid_request_error"}}';
    harness.upstream.setHandler(jsonResponder(404, body));
    const res = await post({ model: 'my-alias', messages: [] });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(body);
  });

  it('请求翻不动（缺 messages）→ 400，且计量记 translate + TRANSLATE_REQUEST_INVALID', async () => {
    const res = await post({ model: 'my-alias' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
    expect(harness.recorder.records[0]).toMatchObject({
      mode: 'translate',
      errorCode: 'TRANSLATE_REQUEST_INVALID',
      status: 'router_error',
    });
    expect(harness.upstream.requests).toHaveLength(0);
  });
});

describe('翻译的边界', () => {
  it('★ 开关关掉 → 退回 M4 的 404 + PROTOCOL_FACE_MISMATCH', async () => {
    harness.setTranslateEnabled(false);
    const res = await post({ model: 'my-alias', messages: [] });
    expect(res.status).toBe(404);
    expect(harness.recorder.records[0]).toMatchObject({ errorCode: 'PROTOCOL_FACE_MISMATCH' });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('★ count_tokens 不翻（OpenAI 侧没有对应端点）→ 404', async () => {
    const res = await post({ model: 'my-alias', messages: [] }, '/v1/messages/count_tokens');
    expect(res.status).toBe(404);
    expect(harness.recorder.records[0]).toMatchObject({ errorCode: 'PROTOCOL_FACE_MISMATCH' });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('★ 反方向（OpenAI 面 → Anthropic 上游）未交付 → 仍然 404', async () => {
    const anthropic = await createHarness({ protocol: 'anthropic' });
    try {
      const res = await anthropic.fetch('/v1/chat/completions', {
        body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
      });
      expect(res.status).toBe(404);
      expect(anthropic.recorder.records[0]).toMatchObject({
        errorCode: 'PROTOCOL_FACE_MISMATCH',
      });
    } finally {
      await anthropic.close();
    }
  });

  it('同协议路由完全不受影响：仍然是 passthrough，字节不动', async () => {
    const same = await createHarness();
    try {
      same.upstream.setHandler(jsonResponder(200, '{"ok":true}'));
      const body = JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] });
      const res = await same.fetch('/v1/messages', { body });
      expect(res.status).toBe(200);
      expect(same.upstream.requests[0].body.toString()).toBe(body);
      expect(same.upstream.requests[0].url).toBe('/v1/messages');
      expect(same.recorder.records[0]).toMatchObject({ mode: 'passthrough' });
    } finally {
      await same.close();
    }
  });

  it('令牌白名单仍在翻译之前判：不允许的 alias 回 403 而不是翻一遍', async () => {
    harness.setSubject({
      tokenId: 'tok-1',
      subjectType: 'run',
      runId: 'run-1',
      agentId: null,
      projectId: null,
      ownerUserId: null,
      allowedModelAliases: ['something-else'],
      maxCostUsd: null,
      maxRequestsPerMinute: null,
    });
    const res = await post({ model: 'my-alias', messages: [] });
    expect(res.status).toBe(403);
    expect(harness.upstream.requests).toHaveLength(0);
  });
});
