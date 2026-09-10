/**
 * 起 / 停一个真实的 `apps/llm-router` 子进程（M7·T7.1）。
 *
 * 验收刻意**不 import `createApp()` 在进程内跑**：A3（滚动更新摘流）、A9（日志
 * 里没有明文）、A11（堆快照对照）这三项的证据都长在**进程边界**上——同进程跑
 * 等于把要证明的东西提前假设掉了。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 跑**构建产物**而不是 `tsx src/server.ts`。
 *
 * 不是为了快——是为了让信号落到对的进程上。`npx tsx …` 会摞出
 * `npx → sh -c → tsx/cli.mjs → node server` 四层，`child.kill()` 只打到最外层，
 * 里面那个真正监听端口的 node 会变成孤儿继续占着端口。A3 要验的恰恰是
 * 「SIGTERM 之后 readyz 立刻 503」，信号送错进程等于什么都没验到；更糟的是
 * 上一轮遗留的孤儿会顶着端口把下一轮的结论全部污染成假阴性。
 *
 * `process.execPath` 直接起 `dist/server.js` = 一个进程、一条信号链。
 */
const SERVER_ENTRY = join(REPO_ROOT, 'apps', 'llm-router', 'dist', 'server.js');

export interface RouterProcessOptions {
  port: number;
  /** 私钥文件路径。**只有这个进程拿得到它**——A11 的对照实验就靠这条。 */
  privateKeyFile: string;
  databaseUrl: string;
  /** 额外 env，覆盖默认值。 */
  env?: Record<string, string | undefined>;
  /** 拿堆快照用：`--heapsnapshot-signal=SIGUSR2`。 */
  nodeOptions?: string;
}

export interface RouterProcess {
  readonly pid: number;
  readonly port: number;
  /** 进程 stdout + stderr 的全量副本。A9 的「日志探针」直接 grep 它。 */
  readonly log: () => string;
  /** 等 `/readyz` 变绿。 */
  waitReady(timeoutMs?: number): Promise<void>;
  /** 发信号（SIGTERM 走优雅退出，SIGUSR2 配合 heapsnapshot-signal 出堆快照）。 */
  signal(sig: NodeJS.Signals): void;
  /** 等进程退出。 */
  waitExit(timeoutMs?: number): Promise<number | null>;
  /** 强杀并回收。 */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 端口被占就**立刻炸**，不要接着跑。
 *
 * 上一轮遗留的副本会顶着端口应答 `/readyz`，于是 `waitReady()` 秒过、后面十项
 * 全打在一个拿着旧目录旧密钥的进程上——测出来的是一整页假阴性，而且看上去像
 * 代码坏了。宁可在这里报「端口占用」。
 */
export async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (err) =>
      reject(
        new Error(
          `port ${port} is already in use (${(err as NodeJS.ErrnoException).code}); ` +
            'a router from a previous run is probably still alive — kill it first'
        )
      )
    );
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

export function startRouter(opts: RouterProcessOptions): RouterProcess {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `llm-router build output not found at ${SERVER_ENTRY}. Run \`pnpm build\` before the acceptance suite.`
    );
  }
  let buffered = '';
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: opts.nodeOptions ?? '',
      PORT: String(opts.port),
      DATABASE_URL: opts.databaseUrl,
      LLM_ROUTER_PRIVATE_KEY_FILE: opts.privateKeyFile,
      // 私钥只走 FILE 这一条路；把 inline 变量显式清掉，避免继承到本进程的值。
      LLM_ROUTER_PRIVATE_KEY: undefined,
      LLM_CATALOG_POLL_MS: '5000',
      DRAIN_TIMEOUT_MS: '2000',
      ...opts.env,
    } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d: Buffer) => {
    buffered += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    buffered += d.toString();
  });

  return {
    pid: child.pid ?? -1,
    port: opts.port,
    log: () => buffered,
    async waitReady(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`llm-router exited early (code ${child.exitCode}):\n${buffered}`);
        }
        try {
          const res = await fetch(`http://127.0.0.1:${opts.port}/readyz`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (res.ok) return;
        } catch {
          // 还没起来
        }
        await sleep(200);
      }
      throw new Error(`llm-router not ready within ${timeoutMs}ms:\n${buffered}`);
    },
    signal(sig: NodeJS.Signals): void {
      child.kill(sig);
    },
    async waitExit(timeoutMs = 20_000): Promise<number | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
        await sleep(100);
      }
      return null;
    },
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      // 等真的死透再返回——否则下一项验收会撞上还没释放的端口。
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await sleep(50);
      }
    },
  };
}

/** 把私钥写进一个 0600 的临时文件——env 里放路径而不是内容（与生产一致）。 */
export function writePrivateKeyFile(privateKeyPem: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-router-acc-'));
  const file = join(dir, 'router.key');
  writeFileSync(file, privateKeyPem, { mode: 0o600 });
  return file;
}
