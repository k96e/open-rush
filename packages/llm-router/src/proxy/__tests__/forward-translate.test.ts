/**
 * translate 档在 `forward()` 里的接线（M4·T4.7）。
 *
 * 与 `forward.test.ts` 一样打**本地假上游**，不碰真供应商。要证五件事：
 *  ① 到达上游的是 OpenAI 形状的 body，且 path 换成了 `/v1/chat/completions`；
 *  ② `anthropic-*` 头不会带给 OpenAI 上游（认证头照常按凭据注入）；
 *  ③ 回给调用方的是 Anthropic 形状的 body / SSE；
 *  ④ **上游错误体仍然原样透传**——翻译只对 2xx 生效（D10 是绝对边界）；
 *  ⑤ 计量按上游真实回的东西记账，`llm_calls.mode` 记 translate。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KEYPAIR, makeCredential, makeRoute } from '../../../test/catalog-fixtures.js';
import {
  type FakeUpstream,
  respondWith,
  startFakeUpstream,
  streamChunks,
} from '../../../test/fake-upstream.js';
import { anthropicToOpenAiTranslator } from '../../adapters/select-translator.js';
import type { Subject } from '../../auth/token-store.js';
import { InMemoryCallRecorder } from '../../metering/call-record.js';
import { type ForwardInput, forward } from '../forward.js';

const ENCODER = new TextEncoder();
const UPSTREAM_SECRET = 'sk-openai-super-secret-value';

const SUBJECT: Subject = {
  tokenId: 'tok-1',
  subjectType: 'run',
  runId: 'run-1',
  agentId: 'agent-1',
  projectId: 'proj-1',
  ownerUserId: 'user-1',
  allowedModelAliases: [],
  maxCostUsd: null,
  maxRequestsPerMinute: null,
};

let upstream: FakeUpstream;
let recorder: InMemoryCallRecorder;

beforeAll(async () => {
  upstream = await startFakeUpstream(respondWith(200, '{}'));
});
afterAll(async () => {
  await upstream.close();
});
beforeEach(() => {
  recorder = new InMemoryCallRecorder();
  upstream.requests.length = 0;
});

/** 跨协议：调用方是 Anthropic 面，上游是 OpenAI 协议。 */
function input(over: Partial<ForwardInput> = {}): ForwardInput {
  const route = makeRoute({
    model: { alias: 'my-alias', upstreamModel: 'gpt-4o' },
    provider: { name: 'openai-prod', protocol: 'openai', baseUrl: upstream.baseUrl },
    credential: makeCredential(UPSTREAM_SECRET),
  });
  const translator = anthropicToOpenAiTranslator({ pingIntervalMs: 0 });
  return {
    route,
    body: translator.translateRequest(
      ENCODER.encode(
        JSON.stringify({
          model: 'my-alias',
          max_tokens: 100,
          system: 'be terse',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ),
      { upstreamModel: 'gpt-4o', stream: over.isStream === true }
    ),
    upstreamPath: translator.upstreamPath,
    inboundHeaders: new Headers({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'context-management-2025-06-27',
    }),
    isStream: false,
    mode: 'translate',
    face: 'anthropic',
    translator,
    subject: SUBJECT,
    requestId: 'req-translate-1',
    privateKeyPem: KEYPAIR.privateKeyPem,
    recorder,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('forward · translate 请求侧', () => {
  it('★ 打到 /v1/chat/completions，body 是 OpenAI 形状', async () => {
    upstream.setHandler(
      respondWith(
        200,
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-4o',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 2 },
        })
      )
    );
    await forward(input());

    const req = upstream.requests[0];
    expect(req.url).toBe('/v1/chat/completions');
    const sent = JSON.parse(req.body.toString()) as Record<string, unknown>;
    expect(sent.model).toBe('gpt-4o');
    expect(sent.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('★ anthropic-* 头不带给 OpenAI 上游，凭据仍按 authStyle 注入', async () => {
    upstream.setHandler(respondWith(200, '{"id":"c","model":"m","choices":[]}'));
    await forward(input());

    const headers = upstream.requests[0].headers;
    expect(headers['anthropic-version']).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(headers.authorization).toBe(`Bearer ${UPSTREAM_SECRET}`);
    expect(headers['accept-encoding']).toBe('identity');
  });
});

describe('forward · translate 响应侧（非流式）', () => {
  it('回给调用方的是 Anthropic 形状，计量按上游 OpenAI 的 usage 记', async () => {
    upstream.setHandler(
      respondWith(
        200,
        JSON.stringify({
          id: 'chatcmpl-9',
          model: 'gpt-4o-2024',
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 40 },
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        })
      )
    );
    const res = await forward(input());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
    });

    expect(recorder.records[0]).toMatchObject({
      mode: 'translate',
      protocol: 'openai',
      status: 'success',
      tokensIn: 60,
      tokensCacheRead: 40,
      tokensOut: 7,
      tokensReasoning: 3,
    });
  });

  it('★ 上游 500 + 自定义错误体：状态码与 body 原样透传，不翻译（D10）', async () => {
    const body = '{"error":{"message":"prompt is too long","type":"invalid_request_error"}}';
    upstream.setHandler(respondWith(500, body));
    const res = await forward(input());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(body);
  });

  it('★ 上游 2xx 但形状认不出来 → 502，且不泄露 baseUrl / 密钥', async () => {
    upstream.setHandler(respondWith(200, '<html>hello from a broken lb</html>'));
    const res = await forward(input());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('openai-prod');
    expect(text).not.toContain(upstream.baseUrl);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(UPSTREAM_SECRET);
    // 错误体按**调用方的面**成形（Anthropic），不是上游协议。
    expect(JSON.parse(text)).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(recorder.records[0]).toMatchObject({
      status: 'upstream_error',
      httpStatus: 502,
      errorCode: 'UPSTREAM_UNTRANSLATABLE',
      mode: 'translate',
    });
  });
});

describe('forward · translate 响应侧（流式）', () => {
  it('★ OpenAI SSE → Anthropic SSE，且用量仍从上游字节里解析', async () => {
    upstream.setHandler(
      streamChunks([
        'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    const res = await forward(input({ isStream: true }));
    const text = await res.text();

    expect(text).toContain('event: message_start');
    expect(text).toContain('"text_delta"');
    expect(text).toContain('event: message_stop');
    // 上游的 OpenAI chunk 不该原样漏给调用方。
    expect(text).not.toContain('chat.completion.chunk');
    expect(text).not.toContain('finish_reason');

    // 计量在翻译**之前**取样：账按上游真实回的 usage 记。
    expect(recorder.records[0]).toMatchObject({
      mode: 'translate',
      stream: true,
      status: 'success',
      tokensIn: 5,
      tokensOut: 2,
    });
  });

  it('★ 流式路径上上游回了非 2xx：body 一个字节都不动', async () => {
    const body = '{"error":{"message":"rate limited by provider"}}';
    upstream.setHandler(respondWith(429, body));
    const res = await forward(input({ isStream: true }));
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(body);
  });
});
