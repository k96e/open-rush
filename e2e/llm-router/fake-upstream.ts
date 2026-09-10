/**
 * 本地假上游（M7·T7.1，R6 前置）。
 *
 * 验收一律打这个进程，**不打真供应商**——理由有两条，缺一不可：
 *  1. 「请求体逐字节一致」只有在上游愿意把收到的原始字节交出来时才可判定；
 *  2. 真供应商的响应每次都不同，「响应体逐字节一致」根本无从比对。
 *
 * 它做三件事：
 *  - 把每次收到的请求（方法 / URL / 头 / **原始 body 字节**）存下来，供 `/__control` 取回；
 *  - 按 fixture **逐字节回放** SSE，分块边界由 `chunkBytes` 控制；
 *  - 用 `?behavior=` 模拟 A10 需要的三种故障（hang / reset / 上游自定义错误体）。
 *
 * ⚠️ 控制面挂在同一个端口的 `/__control/*` 下。网关永远不会转发到这个前缀
 * （它只转发调用方打进来的 path），所以不存在「验收数据被业务流量污染」的问题。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const ANTHROPIC_SSE = readFileSync(join(FIXTURES, 'anthropic-sse.txt'));
export const OPENAI_SSE = readFileSync(join(FIXTURES, 'openai-sse.txt'));
export const ANTHROPIC_JSON = readFileSync(join(FIXTURES, 'messages-resp.json'));

/** 一次被记录下来的上游请求。`body` 是**原始字节**，不是解析结果。 */
export interface CapturedRequest {
  method: string;
  /** 含 query。A1 要验 `?beta=true` 这类 query 原样带到上游。 */
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  receivedAt: number;
}

export interface FakeUpstreamOptions {
  /** 0 = 由内核分配端口（并发跑多个实例时用）。 */
  port?: number;
  /** SSE 回放的分块字节数。越小越能暴露「网关重新分块/丢字节」。 */
  chunkBytes?: number;
  /** 每个分块之间的间隔毫秒，用于把 TTFB 与总耗时拉开（A2）。 */
  chunkDelayMs?: number;
}

export interface FakeUpstream {
  readonly port: number;
  readonly requests: readonly CapturedRequest[];
  reset(): void;
  close(): Promise<void>;
}

/** `behavior` 取值。`reset` 用直接销毁 socket 模拟连接被上游掐断。 */
export type UpstreamBehavior = 'ok' | 'hang' | 'reset' | 'error429' | 'error500';

export function parseBehavior(rawUrl: string): UpstreamBehavior {
  const value = new URL(rawUrl, 'http://x').searchParams.get('behavior');
  switch (value) {
    case 'hang':
    case 'reset':
    case 'error429':
    case 'error500':
      return value;
    default:
      return 'ok';
  }
}

/**
 * 单次请求的 `?delayMs=` 覆盖分块间隔。A3 要一条**跨越 SIGTERM** 的在途流，
 * 而 drain 窗口是进程级配置，只能从请求这一侧把流拉长。
 */
export function parseDelayMs(rawUrl: string, fallback: number): number {
  // `Number(null)` 是 0 —— 直接 Number() 会把「没传这个参数」变成「延迟 0」，
  // 于是构造里配的 chunkDelayMs 永远不生效。先判存在再转。
  const raw = new URL(rawUrl, 'http://x').searchParams.get('delayMs');
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 是不是流式请求。只看 body 里的 `stream` 字段，解析失败一律当非流式。 */
export function isStreamBody(body: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { stream?: unknown }).stream === true
    );
  } catch {
    return false;
  }
}

/** 把一段字节切成固定大小的块。`size <= 0` 视为「整段一块」。 */
export function chunkBuffer(buf: Buffer, size: number): Buffer[] {
  if (size <= 0 || size >= buf.length) return [buf];
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size)
    out.push(buf.subarray(i, Math.min(i + size, buf.length)));
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function headerRecord(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(', ');
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function startFakeUpstream(opts: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const chunkBytes = opts.chunkBytes ?? 64;
  const chunkDelayMs = opts.chunkDelayMs ?? 0;
  let captured: CapturedRequest[] = [];

  const handleControl = (path: string, res: ServerResponse): boolean => {
    if (path === '/__control/requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          captured.map((r, index) => ({
            index,
            method: r.method,
            url: r.url,
            headers: r.headers,
            bodyBase64: r.body.toString('base64'),
            bodySha256: createHash('sha256').update(r.body).digest('hex'),
            receivedAt: r.receivedAt,
          }))
        )
      );
      return true;
    }
    if (path === '/__control/reset') {
      captured = [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return true;
    }
    return false;
  };

  const server: Server = createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? '/';

    if (path.startsWith('/__control/')) {
      if (!handleControl(path, res)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"unknown control endpoint"}');
      }
      return;
    }

    void readBody(req).then(async (body) => {
      captured.push({
        method: req.method ?? 'GET',
        url: rawUrl,
        headers: headerRecord(req),
        body,
        receivedAt: Date.now(),
      });

      const behavior = parseBehavior(rawUrl);
      if (behavior === 'hang') return; // 永不响应；由网关的 timeoutMs 收尾（A10）
      if (behavior === 'reset') {
        req.socket.destroy();
        return;
      }
      if (behavior === 'error429') {
        // 上游自己的 429 形状——**与网关的 429 信封不同**，A10 要验它原样透传。
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end('{"upstream_says":"slow down","quota":{"reset_in":7}}');
        return;
      }
      if (behavior === 'error500') {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('upstream exploded: 上游炸了');
        return;
      }

      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1200}');
        return;
      }

      const openaiFace = path === '/v1/chat/completions';
      if (!isStreamBody(body)) {
        const payload = openaiFace ? openAiJson() : ANTHROPIC_JSON;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }

      const sse = openaiFace ? OPENAI_SSE : ANTHROPIC_SSE;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const perRequestDelay = parseDelayMs(rawUrl, chunkDelayMs);
      for (const chunk of chunkBuffer(sse, chunkBytes)) {
        if (res.writableEnded) return;
        res.write(chunk);
        if (perRequestDelay > 0) await sleep(perRequestDelay);
      }
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        get requests() {
          return captured;
        },
        reset: () => {
          captured = [];
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function openAiJson(): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'chatcmpl-acc-nonstream',
      object: 'chat.completion',
      created: 1_750_000_000,
      model: 'fake-openai-upstream',
      choices: [
        { index: 0, message: { role: 'assistant', content: '等于 2 🚀' }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: 2100,
        completion_tokens: 42,
        total_tokens: 2142,
        prompt_tokens_details: { cached_tokens: 900 },
        completion_tokens_details: { reasoning_tokens: 17 },
      },
    }),
    'utf8'
  );
}

// 直接执行时按 R6 的约定监听 :9999。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_UPSTREAM_PORT ?? 9999);
  void startFakeUpstream({ port, chunkBytes: Number(process.env.FAKE_UPSTREAM_CHUNK ?? 64) }).then(
    (u) => process.stdout.write(`fake-upstream listening on http://127.0.0.1:${u.port}\n`)
  );
}
