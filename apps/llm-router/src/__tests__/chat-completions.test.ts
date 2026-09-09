/**
 * `/v1/chat/completions`（M4·T4.6）。
 *
 * 与 Anthropic 面共用同一条管线，所以这里重点测**差异**：
 * OpenAI 形状的错误体、流式的 `stream_options.include_usage` 注入、
 * 以及 usage 从最后一个 `choices: []` chunk 解析。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  type Harness,
  jsonResponder,
  makeModel,
  makeSnapshot,
  SUBJECT,
  sseResponder,
} from '../../test/harness.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({ protocol: 'openai' });
});

afterEach(async () => {
  await harness.close();
});

const post = (body: unknown) =>
  harness.fetch('/v1/chat/completions', { body: JSON.stringify(body) });

describe('POST /v1/chat/completions · happy path', () => {
  it('非流式：原样透传上游 body，usage 入账', async () => {
    const upstreamBody = JSON.stringify({
      id: 'chatcmpl-1',
      model: 'claude-sonnet-4-6',
      choices: [{ finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    harness.upstream.setHandler(jsonResponder(200, upstreamBody));

    const res = await post({ model: 'claude-sonnet-4-6', messages: [] });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamBody);
    expect(harness.recorder.records[0]).toMatchObject({
      protocol: 'openai',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      costUsd: '18.000000',
    });
  });

  it('★ 非流式不注入 stream_options（请求体逐字节一致）', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{}'));
    const raw = '{"model":"claude-sonnet-4-6","messages":[]}';
    await harness.fetch('/v1/chat/completions', { body: raw });
    expect(harness.upstream.requests[0].body.toString('utf8')).toBe(raw);
    expect(harness.recorder.records[0]).toMatchObject({ mode: 'passthrough' });
  });

  it('★ 流式：注入 stream_options.include_usage，并把 mode 记为 rewrite-model', async () => {
    harness.upstream.setHandler(sseResponder(['data: [DONE]\n\n']));

    // 流式的计量在流 flush 时才出数——先把响应读完。
    await (await post({ model: 'claude-sonnet-4-6', stream: true, messages: [] })).text();

    const sent = JSON.parse(harness.upstream.requests[0].body.toString('utf8'));
    expect(sent).toEqual({
      model: 'claude-sonnet-4-6',
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });
    expect(harness.recorder.records[0]).toMatchObject({ mode: 'rewrite-model', stream: true });
  });

  it('调用方显式 include_usage:false → 不覆盖，mode 仍是 passthrough', async () => {
    harness.upstream.setHandler(sseResponder(['data: [DONE]\n\n']));
    await (
      await post({
        model: 'claude-sonnet-4-6',
        stream: true,
        stream_options: { include_usage: false },
      })
    ).text();
    const sent = JSON.parse(harness.upstream.requests[0].body.toString('utf8'));
    expect(sent.stream_options).toEqual({ include_usage: false });
    expect(harness.recorder.records[0]).toMatchObject({ mode: 'passthrough' });
  });

  it('★ 流式 usage 从最后一个 choices:[] chunk 解析，字节仍逐字节一致', async () => {
    const chunks = [
      'data: {"id":"c1","model":"gpt-x","choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"id":"c1","model":"gpt-x","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":400},"completion_tokens_details":{"reasoning_tokens":120}}}\n\n',
      'data: [DONE]\n\n',
    ];
    harness.upstream.setHandler(sseResponder(chunks));

    const res = await post({ model: 'claude-sonnet-4-6', stream: true });
    expect(await res.text()).toBe(chunks.join(''));

    expect(harness.recorder.records[0]).toMatchObject({
      tokensIn: 600,
      tokensCacheRead: 400,
      tokensOut: 300,
      tokensReasoning: 120,
      upstreamModel: 'gpt-x',
    });
  });

  it('rewrite-model 与 include_usage 注入可以叠加', async () => {
    harness.setSnapshot(
      makeSnapshot({
        models: [makeModel({ alias: 'fast', upstreamModel: 'gpt-x-mini' })],
        providers: [
          {
            id: 'prov-1',
            name: 'openai-prod',
            protocol: 'openai',
            baseUrl: harness.upstream.baseUrl,
            credentialId: 'cred-1',
            defaultHeaders: {},
            timeoutMs: 5000,
          },
        ],
      })
    );
    harness.upstream.setHandler(sseResponder(['data: [DONE]\n\n']));

    await (await post({ model: 'fast', stream: true, messages: [] })).text();

    expect(JSON.parse(harness.upstream.requests[0].body.toString('utf8'))).toEqual({
      model: 'gpt-x-mini',
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });
  });
});

describe('POST /v1/chat/completions · 拒绝路径用 OpenAI 形状', () => {
  it('无令牌 → 401', async () => {
    harness.setSubject(null);
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: 'missing or invalid router token',
        type: 'invalid_api_key',
        code: 'invalid_api_key',
        param: null,
      },
    });
  });

  it('令牌不允许该 alias → 403', async () => {
    harness.setSubject({ ...SUBJECT, allowedModelAliases: ['other'] });
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'insufficient_permissions' },
    });
  });

  it('未知 alias → 404', async () => {
    const res = await post({ model: 'nope' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'model_not_found' } });
  });

  it('非法 JSON → 400', async () => {
    const res = await harness.fetch('/v1/chat/completions', { body: 'oops' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'invalid_request_error' },
    });
  });

  it('缺 model → 400', async () => {
    expect((await post({ messages: [] })).status).toBe(400);
  });

  it('★ 上游是 Anthropic 协议时，OpenAI 面拒绝路由（translate 是 T4.7）', async () => {
    const anthropicHarness = await createHarness({ protocol: 'anthropic' });
    try {
      const res = await anthropicHarness.fetch('/v1/chat/completions', {
        body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      });
      expect(res.status).toBe(404);
      expect(anthropicHarness.recorder.records[0]).toMatchObject({
        errorCode: 'PROTOCOL_FACE_MISMATCH',
      });
    } finally {
      await anthropicHarness.close();
    }
  });

  it('上游 502 → 状态码与 body 原样透传', async () => {
    harness.upstream.setHandler(jsonResponder(502, '{"error":{"message":"bad gateway"}}'));
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('{"error":{"message":"bad gateway"}}');
  });
});
