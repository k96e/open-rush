/**
 * forward() 的联调测试（M4·T4.3，A1 / A5 / A10）。
 *
 * 全部打**本地假上游**，不碰真供应商。要证的四件事：
 *  ① 请求字节原样到达上游、响应字节原样回到调用方；
 *  ② 上游错误体与状态码原样透传，不包信封；
 *  ③ 上游连不上 → 502，且响应体不含 baseUrl、不含任何密钥；
 *  ④ 计量在旁路出数，且不影响返回值。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KEYPAIR, makeCredential, makeRoute } from '../../../test/catalog-fixtures.js';
import {
  type FakeUpstream,
  neverRespond,
  respondWith,
  startFakeUpstream,
  streamChunks,
  unusedPort,
} from '../../../test/fake-upstream.js';
import type { Subject } from '../../auth/token-store.js';
import { InMemoryCallRecorder } from '../../metering/call-record.js';
import { classifyFetchError, type ForwardInput, forward } from '../forward.js';

const ENCODER = new TextEncoder();
const UPSTREAM_SECRET = 'sk-upstream-super-secret-value';

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

function input(over: Partial<ForwardInput> = {}): ForwardInput {
  const route =
    over.route ??
    makeRoute({
      provider: { baseUrl: upstream.baseUrl },
      credential: makeCredential(UPSTREAM_SECRET),
    });
  return {
    route,
    body: ENCODER.encode('{"model":"claude-sonnet-4-6","messages":[]}'),
    upstreamPath: '/v1/messages',
    inboundHeaders: new Headers({ 'content-type': 'application/json' }),
    isStream: false,
    mode: route.mode,
    subject: SUBJECT,
    requestId: 'req-test-1',
    privateKeyPem: KEYPAIR.privateKeyPem,
    recorder,
    signal: new AbortController().signal,
    ...over,
  };
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe('forward · 非流式', () => {
  it('请求字节原样到达上游，响应字节原样返回', async () => {
    const body = ENCODER.encode(
      JSON.stringify({ model: 'claude-sonnet-4-6', system: '你好 🌏', messages: [] })
    );
    const upstreamBody = JSON.stringify({
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '回答 🌏' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    upstream.setHandler(respondWith(200, upstreamBody));

    const res = await forward(input({ body }));

    expect(res.status).toBe(200);
    expect(Buffer.from(upstream.requests[0].body)).toEqual(Buffer.from(body));
    expect(Buffer.from(await bytesOf(res))).toEqual(Buffer.from(upstreamBody, 'utf8'));
  });

  it('query string 一并转发（/v1/messages?beta=true 必须原样到达）', async () => {
    upstream.setHandler(respondWith(200, '{}'));
    await forward(input({ upstreamPath: '/v1/messages?beta=true' }));
    expect(upstream.requests[0].url).toBe('/v1/messages?beta=true');
  });

  it('baseUrl 尾部斜杠不会拼出双斜杠', async () => {
    upstream.setHandler(respondWith(200, '{}'));
    await forward(
      input({
        route: makeRoute({
          provider: { baseUrl: `${upstream.baseUrl}///` },
          credential: makeCredential(UPSTREAM_SECRET),
        }),
      })
    );
    expect(upstream.requests[0].url).toBe('/v1/messages');
  });

  it('解封后的真 key 按 authStyle 注入上游，调用方令牌不外泄', async () => {
    upstream.setHandler(respondWith(200, '{}'));
    await forward(
      input({ inboundHeaders: new Headers({ authorization: 'Bearer rt_caller-token' }) })
    );
    const headers = upstream.requests[0].headers;
    expect(headers.authorization).toBe(`Bearer ${UPSTREAM_SECRET}`);
    expect(JSON.stringify(headers)).not.toContain('rt_caller-token');
  });

  it('★ 上游 500 + 自定义错误体 → 状态码与 body 原样透传，不包信封', async () => {
    const weird = '{"vendor_error":{"code":"quota_drained"},"hint":"充值后重试"}';
    upstream.setHandler(respondWith(500, weird));

    const res = await forward(input());

    expect(res.status).toBe(500);
    expect(new TextDecoder().decode(await bytesOf(res))).toBe(weird);
    expect(recorder.records[0]).toMatchObject({
      status: 'upstream_error',
      httpStatus: 500,
      errorCode: 'UPSTREAM_HTTP_500',
    });
  });

  it('上游 429 与非 JSON 错误体同样照抄', async () => {
    upstream.setHandler(
      respondWith(429, '<html>too many requests</html>', {
        'content-type': 'text/html',
        'retry-after': '30',
      })
    );

    const res = await forward(input());

    expect(res.status).toBe(429);
    expect(await res.text()).toBe('<html>too many requests</html>');
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('计量出数：usage、成本、归属、ttfb/latency', async () => {
    upstream.setHandler(
      respondWith(
        200,
        JSON.stringify({
          model: 'claude-sonnet-4-6-20260101',
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        })
      )
    );

    await forward(
      input({
        inboundHeaders: new Headers({
          'x-claude-code-session-id': 'sess-9',
          'x-claude-code-agent-id': 'agent-9',
        }),
      })
    );

    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toMatchObject({
      requestId: 'req-test-1',
      tokenId: 'tok-1',
      subjectType: 'run',
      runId: 'run-1',
      projectId: 'proj-1',
      ccSessionId: 'sess-9',
      ccAgentId: 'agent-9',
      modelAlias: 'claude-sonnet-4-6',
      upstreamModel: 'claude-sonnet-4-6-20260101',
      protocol: 'anthropic',
      mode: 'passthrough',
      stream: false,
      status: 'success',
      httpStatus: 200,
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      costUsd: '18.000000',
    });
    expect(recorder.records[0].ttfbMs).toBeGreaterThanOrEqual(0);
    expect(recorder.records[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('provider 未绑定凭据时不注入认证头，转发照常', async () => {
    upstream.setHandler(respondWith(200, '{}'));
    const res = await forward(
      input({
        route: makeRoute({
          provider: { baseUrl: upstream.baseUrl, credentialId: null },
          credential: null,
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(upstream.requests[0].headers.authorization).toBeUndefined();
  });
});

describe('forward · 流式', () => {
  const SSE_CHUNKS = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1200,"cache_read_input_tokens":9000,"output_tokens":1}}}\n\n',
    ': ping\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好世界 🌏"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":345}}\n\n',
  ];

  it('SSE 字节逐字节一致（含 ping 与注释行）', async () => {
    upstream.setHandler(streamChunks(SSE_CHUNKS));

    const res = await forward(input({ isStream: true }));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toBe(SSE_CHUNKS.join(''));
  });

  it('流结束后旁路计量出数（累计 usage 取 max）', async () => {
    upstream.setHandler(streamChunks(SSE_CHUNKS));

    const res = await forward(input({ isStream: true }));
    await res.text();
    // onEnd 在流 flush 时同步触发，text() resolve 后记录已经入队
    expect(recorder.records[0]).toMatchObject({
      stream: true,
      status: 'success',
      tokensIn: 1200,
      tokensCacheRead: 9000,
      tokensOut: 345,
      upstreamModel: 'claude-sonnet-4-6',
    });
  });

  it('上游流式返回非 2xx 时同样原样透传', async () => {
    upstream.setHandler(streamChunks(['data: {"type":"error"}\n\n'], 529));
    const res = await forward(input({ isStream: true }));
    expect(res.status).toBe(529);
    expect(await res.text()).toBe('data: {"type":"error"}\n\n');
    expect(recorder.records[0]).toMatchObject({ status: 'upstream_error', httpStatus: 529 });
  });

  it('★ 调用方中途取消 → 记 client_abort', async () => {
    upstream.setHandler(streamChunks(SSE_CHUNKS));
    const controller = new AbortController();
    const res = await forward(input({ isStream: true, signal: controller.signal }));
    const reader = res.body?.getReader();
    await reader?.read();
    controller.abort();
    await reader?.cancel('client gone');
    await new Promise((r) => setTimeout(r, 10));
    expect(recorder.records[0]).toMatchObject({
      status: 'client_abort',
      errorCode: 'CLIENT_ABORT',
      stream: true,
    });
  });

  it('★ 调用方没断而流被中断 → 记 upstream_error，不冤枉客户端', async () => {
    // 上游写了一半就把连接掐掉：调用方的 signal 从没 abort 过。
    upstream.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(SSE_CHUNKS[0]);
      await new Promise((r) => setImmediate(r));
      res.destroy();
    });

    const res = await forward(input({ isStream: true }));
    await res.text().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));

    expect(recorder.records[0]).toMatchObject({
      status: 'upstream_error',
      errorCode: 'UPSTREAM_STREAM_INTERRUPTED',
    });
  });
});

describe('forward · 失败隔离（A10）', () => {
  it('★ 上游连不上 → 502，且响应体不含 baseUrl / 主机 / 端口 / 密钥', async () => {
    const port = await unusedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const res = await forward(
      input({
        route: makeRoute({
          provider: { baseUrl, name: 'anthropic-prod', timeoutMs: 2_000 },
          credential: makeCredential(UPSTREAM_SECRET),
        }),
      })
    );

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('anthropic-prod'); // 只说供应商的名字
    expect(text).not.toContain(baseUrl);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(String(port));
    expect(text).not.toContain(UPSTREAM_SECRET);
    expect(recorder.records[0]).toMatchObject({ status: 'upstream_error', httpStatus: 502 });
  });

  it('上游超时 → 502 且记 UPSTREAM_TIMEOUT', async () => {
    upstream.setHandler(neverRespond);
    const res = await forward(
      input({
        route: makeRoute({
          provider: { baseUrl: upstream.baseUrl, timeoutMs: 120 },
          credential: makeCredential(UPSTREAM_SECRET),
        }),
      })
    );
    expect(res.status).toBe(502);
    expect(recorder.records[0]).toMatchObject({
      status: 'upstream_error',
      errorCode: 'UPSTREAM_TIMEOUT',
    });
  });

  it('调用方在建连阶段就断开 → 记 client_abort，不记 upstream_error', async () => {
    upstream.setHandler(neverRespond);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const res = await forward(
      input({
        signal: controller.signal,
        route: makeRoute({
          provider: { baseUrl: upstream.baseUrl, timeoutMs: 10_000 },
          credential: makeCredential(UPSTREAM_SECRET),
        }),
      })
    );
    expect(res.status).toBe(502);
    expect(recorder.records[0]).toMatchObject({ status: 'client_abort', httpStatus: null });
  });

  it('★ 密文与本副本私钥不匹配 → 500，且错误体只提凭据名字、不含密文片段', async () => {
    const foreign = makeCredential(UPSTREAM_SECRET);
    const res = await forward(
      input({
        route: makeRoute({
          provider: { baseUrl: upstream.baseUrl },
          credential: { ...foreign, keyId: 'f'.repeat(32) },
        }),
      })
    );

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('anthropic-prod');
    expect(text).not.toContain(foreign.sealedValue.slice(0, 24));
    expect(text).not.toContain(UPSTREAM_SECRET);
    expect(text).not.toContain(foreign.keyId);
    expect(recorder.records[0]).toMatchObject({
      status: 'router_error',
      httpStatus: 500,
      errorCode: 'CREDENTIAL_UNSEALABLE',
    });
    // 一个字节都没发出去
    expect(upstream.requests).toHaveLength(0);
  });

  it('★ 计量 recorder 违约抛错时转发照常返回（A5）', async () => {
    upstream.setHandler(respondWith(200, '{"ok":true}'));
    const throwing = {
      enqueue() {
        throw new Error('recorder down');
      },
    };

    const res = await forward(input({ recorder: throwing }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('★ 流式下 recorder 抛错也不打断字节流（A5）', async () => {
    upstream.setHandler(streamChunks(['data: {"type":"message_stop"}\n\n']));
    const res = await forward(
      input({
        isStream: true,
        recorder: {
          enqueue() {
            throw new Error('recorder down');
          },
        },
      })
    );
    expect(await res.text()).toBe('data: {"type":"message_stop"}\n\n');
  });
});

describe('classifyFetchError', () => {
  it.each([
    [{ name: 'TimeoutError' }, 'UPSTREAM_TIMEOUT'],
    [{ name: 'AbortError' }, 'CLIENT_ABORT'],
    [{ name: 'TypeError', cause: { code: 'ECONNREFUSED' } }, 'UPSTREAM_ECONNREFUSED'],
    [{ name: 'TypeError' }, 'UPSTREAM_FETCH_FAILED'],
    [null, 'UPSTREAM_FETCH_FAILED'],
  ])('%o → %s', (err, expected) => {
    expect(classifyFetchError(err)).toBe(expected);
  });
});
