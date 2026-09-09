/**
 * `/v1/messages` 与 `/v1/messages/count_tokens`（M4·T4.5）。
 *
 * happy path、四类拒绝（401/403/404/400）、流式、以及 A1 的字节一致。
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
  UPSTREAM_SECRET,
} from '../../test/harness.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

const post = (body: unknown, init: RequestInit = {}) =>
  harness.fetch('/v1/messages', { body: JSON.stringify(body), ...init });

describe('POST /v1/messages · happy path', () => {
  it('转发成功并原样返回上游 body', async () => {
    const upstreamBody = JSON.stringify({
      id: 'msg_1',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    harness.upstream.setHandler(jsonResponder(200, upstreamBody));

    const res = await post({ model: 'claude-sonnet-4-6', messages: [] });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamBody);
  });

  it('★ passthrough 模式下请求体逐字节一致', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{}'));
    const raw = '{"model":"claude-sonnet-4-6","system":"你好 🌏","messages":[],"stream":false}';

    await harness.fetch('/v1/messages', { body: raw });

    expect(harness.upstream.requests[0].body.toString('utf8')).toBe(raw);
  });

  it('★ 按 path 匹配：/v1/messages?beta=true 命中，且 query 原样带给上游', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{}'));
    const res = await harness.fetch('/v1/messages?beta=true', {
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(200);
    expect(harness.upstream.requests[0].url).toBe('/v1/messages?beta=true');
  });

  it('★ 从未见过的 anthropic-beta 值原样到达上游（证明没有白名单）', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{}'));
    await harness.fetch('/v1/messages', {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer rt_caller',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'totally-new-capability-2099-01-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(harness.upstream.requests[0].headers['anthropic-beta']).toBe(
      'totally-new-capability-2099-01-01'
    );
    expect(harness.upstream.requests[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  it('调用方令牌被消费，上游拿到的是解封后的真 key', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{}'));
    await post({ model: 'claude-sonnet-4-6' });
    const headers = harness.upstream.requests[0].headers;
    expect(headers.authorization).toBe(`Bearer ${UPSTREAM_SECRET}`);
    expect(JSON.stringify(headers)).not.toContain('rt_caller');
  });

  it('rewrite-model 模式：只把 $.model 换成 upstreamModel', async () => {
    harness.setSnapshot(
      makeSnapshot({
        models: [makeModel({ alias: 'fast', upstreamModel: 'claude-haiku-4-5-20251001' })],
        providers: [
          {
            id: 'prov-1',
            name: 'anthropic-prod',
            protocol: 'anthropic',
            baseUrl: harness.upstream.baseUrl,
            credentialId: 'cred-1',
            defaultHeaders: {},
            timeoutMs: 5000,
          },
        ],
      })
    );
    harness.upstream.setHandler(jsonResponder(200, '{}'));

    await post({ model: 'fast', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

    const sent = JSON.parse(harness.upstream.requests[0].body.toString('utf8'));
    expect(sent).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(harness.recorder.records[0]).toMatchObject({ mode: 'rewrite-model' });
  });

  it('流式：SSE 字节逐字节一致，usage 旁路出数', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
      ': ping\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
    ];
    harness.upstream.setHandler(sseResponder(chunks));

    const res = await post({ model: 'claude-sonnet-4-6', stream: true });
    const text = await res.text();

    expect(text).toBe(chunks.join(''));
    expect(harness.recorder.records[0]).toMatchObject({
      stream: true,
      status: 'success',
      tokensIn: 100,
      tokensOut: 42,
    });
  });

  it('上游 500 + 自定义错误体 → 状态码与 body 原样透传', async () => {
    harness.upstream.setHandler(jsonResponder(500, '{"vendor":"boom","hint":"稍后重试"}'));
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"vendor":"boom","hint":"稍后重试"}');
  });

  it('计量记录带上 cc_* 分组提示，归属仍来自令牌', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{}'));
    await harness.fetch('/v1/messages', {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer rt_caller',
        'x-claude-code-session-id': 'sess-1',
        'x-claude-code-agent-id': 'agent-forged',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(harness.recorder.records[0]).toMatchObject({
      ccSessionId: 'sess-1',
      ccAgentId: 'agent-forged',
      runId: SUBJECT.runId,
      agentId: SUBJECT.agentId, // ← 令牌上的，不是 header 里那个
    });
  });
});

describe('POST /v1/messages · 拒绝路径', () => {
  it('无令牌 → 401，Anthropic 形状', async () => {
    harness.setSubject(null);
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'missing or invalid router token' },
    });
    // 401 不写 llm_calls（没有 subject，归属列无从填起）
    expect(harness.recorder.records).toHaveLength(0);
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('令牌不允许该 alias → 403，且不泄露该模型是否存在', async () => {
    harness.setSubject({ ...SUBJECT, allowedModelAliases: ['other-model'] });
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('permission_error');
    expect(harness.recorder.records[0]).toMatchObject({
      status: 'forbidden',
      httpStatus: 403,
      errorCode: 'ALIAS_NOT_ALLOWED',
      modelAlias: 'claude-sonnet-4-6',
    });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('未知 alias → 404，且错误体不枚举目录里的其他模型', async () => {
    const res = await post({ model: 'no-such-model' });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain('no-such-model');
    expect(text).not.toContain('claude-sonnet-4-6');
    expect(harness.recorder.records[0]).toMatchObject({
      status: 'model_not_found',
      errorCode: 'MODEL_NOT_FOUND',
    });
  });

  it('body 非法 JSON → 400', async () => {
    const res = await harness.fetch('/v1/messages', { body: '{not json' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { type: 'invalid_request_error' },
    });
    expect(harness.recorder.records[0]).toMatchObject({
      status: 'router_error',
      errorCode: 'INVALID_JSON',
    });
  });

  it('body 是 JSON 数组 → 400', async () => {
    const res = await harness.fetch('/v1/messages', { body: '[1,2,3]' });
    expect(res.status).toBe(400);
  });

  it('缺 model → 400', async () => {
    const res = await post({ messages: [] });
    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toContain("field 'model' is required");
    expect(harness.recorder.records[0]).toMatchObject({ errorCode: 'MISSING_MODEL' });
  });

  it('model 是空白串 → 400', async () => {
    expect((await post({ model: '   ' })).status).toBe(400);
  });

  it('model 不是字符串 → 400', async () => {
    expect((await post({ model: 42 })).status).toBe(400);
  });

  it('目录未加载 → 500，且不打上游', async () => {
    harness.setSnapshot(null);
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(500);
    expect(harness.recorder.records[0]).toMatchObject({ errorCode: 'CATALOG_NOT_LOADED' });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  /**
   * T4.7 之前这里断言的是 404：跨协议一律拒绝。翻译交付之后行为**有意改变**
   * ——同一份目录现在会走 translate 档转给 OpenAI 上游。完整的翻译用例在
   * `translate.test.ts`；这里只钉住「跨协议不再是拒绝路径」这一条，
   * 免得将来有人把 404 当成回归给「修」回去。
   */
  it('★ 上游是 OpenAI 协议时走 translate 档，不再拒绝（T4.7）', async () => {
    harness.setSnapshot(
      makeSnapshot({
        models: [makeModel()],
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
    harness.upstream.setHandler(
      jsonResponder(
        200,
        '{"id":"c","model":"gpt-4o","choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}'
      )
    );
    const res = await post({ model: 'claude-sonnet-4-6', messages: [] });
    expect(res.status).toBe(200);
    expect(harness.recorder.records[0]).toMatchObject({ mode: 'translate', status: 'success' });
    expect(harness.upstream.requests[0].url).toBe('/v1/chat/completions');
  });

  it('★ 关掉翻译开关后跨协议回到 404 + PROTOCOL_FACE_MISMATCH', async () => {
    harness.setTranslateEnabled(false);
    harness.setSnapshot(
      makeSnapshot({
        models: [makeModel()],
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
    const res = await post({ model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(404);
    expect(harness.recorder.records[0]).toMatchObject({ errorCode: 'PROTOCOL_FACE_MISMATCH' });
    expect(harness.upstream.requests).toHaveLength(0);
  });
});

describe('POST /v1/messages/count_tokens', () => {
  it('转发到上游的同一条 path 并原样返回', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{"input_tokens":123}'));
    const res = await harness.fetch('/v1/messages/count_tokens', {
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ input_tokens: 123 });
    expect(harness.upstream.requests[0].url).toBe('/v1/messages/count_tokens');
  });

  it('即使 body 写了 stream:true 也走缓冲分支（计数端点没有流）', async () => {
    harness.upstream.setHandler(jsonResponder(200, '{"input_tokens":5}'));
    await harness.fetch('/v1/messages/count_tokens', {
      body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true }),
    });
    expect(harness.recorder.records[0]).toMatchObject({ stream: false });
  });

  it('无令牌 → 401', async () => {
    harness.setSubject(null);
    const res = await harness.fetch('/v1/messages/count_tokens', {
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(401);
  });

  it('未知 alias → 404', async () => {
    const res = await harness.fetch('/v1/messages/count_tokens', {
      body: JSON.stringify({ model: 'nope' }),
    });
    expect(res.status).toBe(404);
  });
});
