/**
 * 假上游（M4·T4.3/T4.5 的联调对象）。**单测绝不打真供应商。**
 *
 * 用 node:http 而不是 mock fetch：要证的恰恰是「真的走了一趟网络之后字节仍然
 * 一致、头仍然是我们组装的那些」——mock 掉 fetch 就把被测对象一起 mock 掉了。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer
) => void | Promise<void>;

export interface FakeUpstream {
  baseUrl: string;
  requests: CapturedRequest[];
  /** 换一个 handler，同一个端口。 */
  setHandler(handler: UpstreamHandler): void;
  close(): Promise<void>;
}

export async function startFakeUpstream(initial: UpstreamHandler): Promise<FakeUpstream> {
  let handler = initial;
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      void handler(req, res, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setHandler(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

/** 一次性回一段字节，可指定状态码与响应头。 */
export function respondWith(
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {}
): UpstreamHandler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  };
}

/** 按给定分块逐段写出（模拟 SSE 流），块之间可以插入延迟。 */
export function streamChunks(
  chunks: (string | Buffer)[],
  status = 200,
  headers: Record<string, string> = {}
): UpstreamHandler {
  return async (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/event-stream', ...headers });
    for (const chunk of chunks) {
      res.write(chunk);
      await new Promise((r) => setImmediate(r));
    }
    res.end();
  };
}

/** 一个不会响应的 handler，用来触发超时。 */
export const neverRespond: UpstreamHandler = () => {};

/** 找一个必定没人监听的端口（用于「上游连不上」的用例）。 */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  return port;
}
