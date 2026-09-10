import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeAgentWorker, startFakeAgentWorker } from '../lib/fake-agent-worker.js';

/** 一个假网关：只记录收到了什么，回一个最小的 SSE。 */
interface StubGateway {
  port: number;
  requests: Array<{ auth: string | null; ccSession: string | null; model: string | null }>;
  close(): Promise<void>;
}

function startStubGateway(): Promise<StubGateway> {
  const requests: StubGateway['requests'] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as { model?: string };
      requests.push({
        auth: req.headers.authorization ?? null,
        ccSession: (req.headers['x-claude-code-session-id'] as string | undefined) ?? null,
        model: body.model ?? null,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"message_stop"}\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('startFakeAgentWorker', () => {
  let worker: FakeAgentWorker;
  let gateway: StubGateway;
  let base: string;

  beforeAll(async () => {
    gateway = await startStubGateway();
    worker = await startFakeAgentWorker(0);
    base = `http://127.0.0.1:${worker.port}`;
  });
  afterAll(async () => {
    await worker.close();
    await gateway.close();
  });

  const prompt = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'hi',
        sessionId: 'run-1234abcd-5678',
        modelId: 'acc-passthrough',
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.port}`,
          ANTHROPIC_AUTH_TOKEN: 'rt_fake-token',
        },
        ...extra,
      }),
    });
    return res.text();
  };

  it('/health 回 ok —— 编排器的健康检查走这条', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('拿 env 里的 base url + 令牌打网关，次数等于 callsPerPrompt', async () => {
    worker.callsPerPrompt = 2;
    gateway.requests.length = 0;
    await prompt();
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0].auth).toBe('Bearer rt_fake-token');
    expect(gateway.requests[0].model).toBe('acc-passthrough');
  });

  it('发出的 x-claude-code-session-id 与 runId 不同 —— 它是**伪造**的分组提示', async () => {
    worker.callsPerPrompt = 1;
    gateway.requests.length = 0;
    await prompt();
    const cc = gateway.requests[0].ccSession;
    expect(cc).toMatch(/^forged-/);
    expect(cc).not.toBe('run-1234abcd-5678');
  });

  it('env 里没有网关地址时不打任何请求（而不是崩掉）', async () => {
    worker.callsPerPrompt = 1;
    gateway.requests.length = 0;
    await prompt({ env: {} });
    expect(gateway.requests).toHaveLength(0);
    expect(worker.calls.at(-1)?.gatewayStatuses).toEqual([0]);
  });

  it('回的是 SSE① 形状的 UIMessageChunk 流，以 [DONE] 收尾', async () => {
    worker.callsPerPrompt = 1;
    const text = await prompt();
    expect(text).toContain('data: {"type":"start"}');
    expect(text).toContain('"type":"text-delta"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('记录下沙箱实际拿到的那份 env（A9 / A11 的探针输入）', async () => {
    worker.callsPerPrompt = 1;
    await prompt();
    const last = worker.calls.at(-1);
    expect(last?.env.ANTHROPIC_AUTH_TOKEN).toBe('rt_fake-token');
    expect(last?.modelId).toBe('acc-passthrough');
  });

  it('tailDelayMs 把「最后一次调用」与「流收尾」拉开', async () => {
    worker.callsPerPrompt = 1;
    worker.tailDelayMs = 250;
    const t0 = Date.now();
    await prompt();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    worker.tailDelayMs = 0;
  });

  it('未知路径回 404', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
