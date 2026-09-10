import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANTHROPIC_SSE,
  chunkBuffer,
  type FakeUpstream,
  isStreamBody,
  parseBehavior,
  parseDelayMs,
  startFakeUpstream,
} from '../fake-upstream.js';

describe('parseBehavior', () => {
  it('已知取值原样返回', () => {
    expect(parseBehavior('/v1/messages?behavior=hang')).toBe('hang');
    expect(parseBehavior('/v1/messages?behavior=reset')).toBe('reset');
    expect(parseBehavior('/v1/messages?behavior=error429')).toBe('error429');
    expect(parseBehavior('/v1/messages?behavior=error500')).toBe('error500');
  });

  it('未知取值与缺省一律当 ok —— 拼错参数不该静默变成故障注入', () => {
    expect(parseBehavior('/v1/messages')).toBe('ok');
    expect(parseBehavior('/v1/messages?behavior=explode')).toBe('ok');
    expect(parseBehavior('/v1/messages?behavior=')).toBe('ok');
  });
});

describe('parseDelayMs', () => {
  it('解析出合法的非负数', () => {
    expect(parseDelayMs('/x?delayMs=90', 0)).toBe(90);
    expect(parseDelayMs('/x?delayMs=0', 5)).toBe(0);
  });

  it('缺省 / 非数 / 负数都回落到 fallback', () => {
    expect(parseDelayMs('/x', 7)).toBe(7);
    expect(parseDelayMs('/x?delayMs=abc', 7)).toBe(7);
    expect(parseDelayMs('/x?delayMs=-1', 7)).toBe(7);
  });
});

describe('isStreamBody', () => {
  it('只认 body 里字面量 true 的 stream 字段', () => {
    expect(isStreamBody(Buffer.from('{"stream":true}'))).toBe(true);
    expect(isStreamBody(Buffer.from('{"stream":false}'))).toBe(false);
    expect(isStreamBody(Buffer.from('{"stream":"true"}'))).toBe(false);
    expect(isStreamBody(Buffer.from('{}'))).toBe(false);
  });

  it('解析失败一律当非流式', () => {
    expect(isStreamBody(Buffer.from('not json'))).toBe(false);
    expect(isStreamBody(Buffer.from(''))).toBe(false);
    expect(isStreamBody(Buffer.from('[1,2]'))).toBe(false);
  });
});

describe('chunkBuffer', () => {
  it('按大小切块且拼回去与原始字节相同', () => {
    const buf = Buffer.from('0123456789');
    const chunks = chunkBuffer(buf, 3);
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 3, 1]);
    expect(Buffer.concat(chunks).equals(buf)).toBe(true);
  });

  it('size <= 0 或 >= 长度时整段一块', () => {
    const buf = Buffer.from('abc');
    expect(chunkBuffer(buf, 0)).toHaveLength(1);
    expect(chunkBuffer(buf, -1)).toHaveLength(1);
    expect(chunkBuffer(buf, 99)).toHaveLength(1);
  });
});

describe('startFakeUpstream', () => {
  let upstream: FakeUpstream;
  let base: string;

  beforeAll(async () => {
    upstream = await startFakeUpstream({ port: 0, chunkBytes: 16 });
    base = `http://127.0.0.1:${upstream.port}`;
  });
  afterAll(async () => {
    await upstream.close();
  });

  it('逐字节回放 SSE fixture，分块再多也不改字节', async () => {
    upstream.reset();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(bytes.equals(ANTHROPIC_SSE)).toBe(true);
  });

  it('把请求的原始字节、URL 与请求头都记下来', async () => {
    upstream.reset();
    const body = JSON.stringify({ stream: false, note: '多字节 🚀' });
    await fetch(`${base}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-beta': 'unseen-2099' },
      body,
    });
    const captured = upstream.requests[0];
    expect(captured.url).toBe('/v1/messages?beta=true');
    expect(captured.body.toString('utf8')).toBe(body);
    expect(captured.headers['anthropic-beta']).toBe('unseen-2099');
  });

  it('非流式请求回 JSON', async () => {
    upstream.reset();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stream":false}',
    });
    const json = (await res.json()) as { type?: string };
    expect(json.type).toBe('message');
  });

  it('OpenAI 面走 chat/completions 的 fixture', async () => {
    upstream.reset();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stream":false}',
    });
    const json = (await res.json()) as { object?: string };
    expect(json.object).toBe('chat.completion');
  });

  it('error429 回上游自己的错误体（**不是**网关的信封）', async () => {
    upstream.reset();
    const res = await fetch(`${base}/v1/messages?behavior=error429`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(await res.text()).toBe('{"upstream_says":"slow down","quota":{"reset_in":7}}');
  });

  it('error500 回非 JSON 错误体', async () => {
    upstream.reset();
    const res = await fetch(`${base}/v1/messages?behavior=error500`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('上游炸了');
  });

  it('reset 直接掐断连接 —— 调用方拿到的是网络错误而不是 HTTP 响应', async () => {
    upstream.reset();
    await expect(
      fetch(`${base}/v1/messages?behavior=reset`, { method: 'POST', body: '{}' })
    ).rejects.toThrow();
  });

  it('hang 永不响应，由调用方的超时收尾', async () => {
    upstream.reset();
    await expect(
      fetch(`${base}/v1/messages?behavior=hang`, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(300),
      })
    ).rejects.toThrow();
    expect(upstream.requests).toHaveLength(1); // 请求确实到了，只是没回
  });

  it('count_tokens 有自己的形状', async () => {
    upstream.reset();
    const res = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({ input_tokens: 1200 });
  });

  it('控制面能取回捕获的请求，也能清空', async () => {
    upstream.reset();
    await fetch(`${base}/v1/messages`, { method: 'POST', body: '{"stream":false}' });
    const listed = (await (await fetch(`${base}/__control/requests`)).json()) as Array<{
      bodyBase64: string;
      bodySha256: string;
    }>;
    expect(listed).toHaveLength(1);
    expect(Buffer.from(listed[0].bodyBase64, 'base64').toString('utf8')).toBe('{"stream":false}');
    expect(listed[0].bodySha256).toMatch(/^[0-9a-f]{64}$/);

    await fetch(`${base}/__control/reset`);
    expect(upstream.requests).toHaveLength(0);
  });

  it('未知控制面端点回 404，不会被当成业务请求记进去', async () => {
    upstream.reset();
    const res = await fetch(`${base}/__control/nope`);
    expect(res.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });
});
