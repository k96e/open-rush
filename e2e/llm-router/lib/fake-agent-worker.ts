/**
 * 假 agent-worker（M7·T7.1）。
 *
 * 它替掉的是 Claude Code CLI 那一段，**其余全是真的**：`RunOrchestrator` 真地签发
 * per-run 令牌、真地把 env 注进来、真地消费 SSE①、真地在 finally 里吊销。
 * 这里只做一件 CLI 会做的事——**拿 env 里的 `ANTHROPIC_BASE_URL` +
 * `ANTHROPIC_AUTH_TOKEN` 去打网关**，然后按 UIMessageChunk 形状把结果流回去。
 *
 * 这样 A5 的「逐调用记录 ↔ run 级 `data-openrush-usage` 对账」才是端到端的：
 * 两端的数字都不是脚本自己填的。
 *
 * 顺带它还是 A11 的一处探针：`lastEnv` 就是沙箱会拿到的那份 env——里面必须
 * 只有网关令牌，不能有供应商真 key（M6·T6.3 的密钥边界）。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface PromptCall {
  prompt: string;
  sessionId: string | null;
  modelId: string | null;
  env: Record<string, string>;
  /** 这次 prompt 里实际打给网关的调用结果。 */
  gatewayStatuses: number[];
}

export interface FakeAgentWorker {
  readonly port: number;
  readonly calls: readonly PromptCall[];
  /** 每次 prompt 打几次网关。默认 3——A5 要验「行数 == 实际调用次数」。 */
  callsPerPrompt: number;
  /**
   * 最后一次网关调用与 SSE① 收尾之间的停顿。
   *
   * 真实 run 在最后一次模型调用之后还要跑工具、写文件、收尾，不会「模型一返回
   * 就 done」。这里显式留出这段时间，是因为 `RunOrchestrator` 一消费完 SSE① 就
   * 去聚合 `llm_calls`，而网关的计量是**异步批写**——两者之间存在竞态（见
   * docs/llm-router-acceptance.md 的 A5 取舍）。
   */
  tailDelayMs: number;
  close(): Promise<void>;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
        resolve(
          typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
        );
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 用注入进来的 env 打一次网关。刻意用**流式**——Claude Code 走的就是流式路径，
 * 非流式路径在网关里会多一次缓冲（A2 的取舍）。
 */
async function callGateway(
  env: Record<string, string>,
  modelAlias: string,
  sessionId: string | null
): Promise<number> {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const token = env.ANTHROPIC_AUTH_TOKEN;
  if (!baseUrl || !token) return 0;

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      // D6：这是**伪造的**分组提示。A5 要验它只进 cc_session_id，
      // 绝不参与归属——run_id 必须仍然来自令牌。
      // 刻意与 runId **不同**：沙箱里有 bash，这个头想写什么写什么。
      // A5 要验的正是「它只进 cc_session_id，不参与归属」。
      'x-claude-code-session-id': `forged-${sessionId?.slice(0, 8) ?? 'x'}-not-a-run-id`,
    },
    body: JSON.stringify({
      model: modelAlias,
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  // 必须把流读完，否则网关侧记的是 client_abort 而不是 ok。
  await res.arrayBuffer();
  return res.status;
}

export function startFakeAgentWorker(port = 0): Promise<FakeAgentWorker> {
  const calls: PromptCall[] = [];
  let callsPerPrompt = 3;
  let tailDelayMs = 0;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (path === '/__control/calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(calls));
      return;
    }
    if (path !== '/prompt') {
      res.writeHead(404);
      res.end();
      return;
    }

    void readJson(req).then(async (body) => {
      const env = (body.env as Record<string, string> | undefined) ?? {};
      const modelId = str(body.modelId);
      const sessionId = str(body.sessionId);
      const statuses: number[] = [];
      for (let i = 0; i < callsPerPrompt; i += 1) {
        statuses.push(await callGateway(env, modelId ?? 'sonnet', sessionId));
      }
      if (tailDelayMs > 0) await sleep(tailDelayMs);
      calls.push({
        prompt: str(body.prompt) ?? '',
        sessionId,
        modelId,
        env,
        gatewayStatuses: statuses,
      });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      const emit = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      emit({ type: 'start' });
      emit({ type: 'text-start', id: 'blk-0' });
      emit({ type: 'text-delta', id: 'blk-0', delta: `called gateway ${statuses.length}x` });
      emit({ type: 'text-end', id: 'blk-0' });
      emit({ type: 'finish' });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        get calls() {
          return calls;
        },
        get callsPerPrompt() {
          return callsPerPrompt;
        },
        set callsPerPrompt(n: number) {
          callsPerPrompt = n;
        },
        get tailDelayMs() {
          return tailDelayMs;
        },
        set tailDelayMs(n: number) {
          tailDelayMs = n;
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
