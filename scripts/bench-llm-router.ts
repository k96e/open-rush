/**
 * 网关转发性能基线（M7·T7.2，R6 的 A2）。
 *
 *   npx tsx scripts/bench-llm-router.ts \
 *     --gateway http://127.0.0.1:8790 --upstream http://127.0.0.1:9999 \
 *     --token rt_xxx --model acc-passthrough --n 500 --concurrency 1,8,32
 *
 * 判定口径：**同一 fixture、同一并发**下，`p95(经网关) − p95(直连假上游)`。
 * 一律打本地假上游——打真供应商的话，网络抖动会淹没掉个位数毫秒的网关开销，
 * 测出来的是运营商而不是代码。
 *
 * 两个数分开报（R6 明确要求）：
 *  - **TTFB 附加延迟**：网关的价值就在这里——先 enqueue 后 observe，
 *    首字节不等计量；
 *  - **总耗时附加延迟**：包含把整条流转完的开销。
 *
 * 非流式请求会在网关侧完整缓冲 body（为了解析 usage），因此 `--stream false`
 * 测出来的总耗时天然更高一档。Claude Code 走的是流式路径。
 */

export interface BenchArgs {
  gateway: string;
  upstream: string;
  token: string;
  model: string;
  n: number;
  concurrency: number[];
  stream: boolean;
  json: boolean;
}

const DEFAULTS: BenchArgs = {
  gateway: 'http://127.0.0.1:8790',
  upstream: 'http://127.0.0.1:9999',
  token: '',
  model: 'acc-passthrough',
  n: 200,
  concurrency: [1, 8, 32],
  stream: true,
  json: false,
};

export function parseArgs(argv: readonly string[]): BenchArgs {
  const out: BenchArgs = { ...DEFAULTS, concurrency: [...DEFAULTS.concurrency] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (name === 'json') {
      out.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    i += 1;
    switch (name) {
      case 'gateway':
        out.gateway = value.replace(/\/$/, '');
        break;
      case 'upstream':
        out.upstream = value.replace(/\/$/, '');
        break;
      case 'token':
        out.token = value;
        break;
      case 'model':
        out.model = value;
        break;
      case 'n':
        out.n = Math.max(1, Number(value) || DEFAULTS.n);
        break;
      case 'concurrency':
        out.concurrency = value
          .split(',')
          .map((s) => Math.max(1, Number(s.trim()) || 1))
          .filter((v, idx, arr) => arr.indexOf(v) === idx);
        break;
      case 'stream':
        out.stream = value !== 'false';
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 最近秩插值的百分位。样本为空返回 `Number.NaN`——**不要**返回 0，
 * 那会让「没测到」和「快得测不出来」在报表上长得一模一样。
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(samples: readonly number[]): Summary {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples.length === 0 ? Number.NaN : Math.max(...samples),
  };
}

export interface LegResult {
  ttfb: Summary;
  total: Summary;
  errors: number;
}

export interface ConcurrencyResult {
  concurrency: number;
  direct: LegResult;
  gateway: LegResult;
  /** 附加延迟 = 网关 − 直连。TTFB 与总耗时分开报（R6 要求）。 */
  deltaTtfbP95: number;
  deltaTotalP95: number;
}

export interface BenchReport {
  args: Omit<BenchArgs, 'token' | 'json'>;
  results: ConcurrencyResult[];
}

const round = (v: number): number => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

export function formatTable(report: BenchReport): string {
  const lines = [
    '| 并发 | 直连 TTFB p95 | 网关 TTFB p95 | **ΔTTFB p95** | 直连总耗时 p95 | 网关总耗时 p95 | **Δ总耗时 p95** | 错误 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of report.results) {
    lines.push(
      `| ${r.concurrency} | ${round(r.direct.ttfb.p95)} ms | ${round(r.gateway.ttfb.p95)} ms | **${round(r.deltaTtfbP95)} ms** | ${round(r.direct.total.p95)} ms | ${round(r.gateway.total.p95)} ms | **${round(r.deltaTotalP95)} ms** | ${r.direct.errors + r.gateway.errors} |`
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 采样
// ---------------------------------------------------------------------------

interface Sample {
  ttfbMs: number;
  totalMs: number;
  ok: boolean;
}

async function oneCall(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<Sample> {
  const t0 = performance.now();
  let ttfbMs = Number.NaN;
  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    const reader = res.body?.getReader();
    if (reader) {
      await reader.read(); // 首个 body 分块 = TTFB
      ttfbMs = performance.now() - t0;
      // 剩下的读完，否则连接不会归还，后续并发会被拖慢。
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } else {
      ttfbMs = performance.now() - t0;
    }
    return { ttfbMs, totalMs: performance.now() - t0, ok: res.ok };
  } catch {
    return { ttfbMs, totalMs: performance.now() - t0, ok: false };
  }
}

async function runLeg(
  url: string,
  headers: Record<string, string>,
  body: string,
  n: number,
  concurrency: number
): Promise<LegResult> {
  const samples: Sample[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= n) return;
      samples.push(await oneCall(url, headers, body));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  const ok = samples.filter((s) => s.ok);
  return {
    ttfb: summarize(ok.map((s) => s.ttfbMs)),
    total: summarize(ok.map((s) => s.totalMs)),
    errors: samples.length - ok.length,
  };
}

export async function runBench(args: BenchArgs): Promise<BenchReport> {
  const body = JSON.stringify({
    model: args.model,
    max_tokens: 64,
    stream: args.stream,
    messages: [{ role: 'user', content: 'bench' }],
  });
  const common = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  const results: ConcurrencyResult[] = [];

  for (const concurrency of args.concurrency) {
    // 预热：第一次调用要建连、要加载 JIT，算进 p95 会把网关冤枉一大截。
    await runLeg(`${args.upstream}/v1/messages`, common, body, Math.min(20, args.n), concurrency);
    await runLeg(
      `${args.gateway}/v1/messages`,
      { ...common, authorization: `Bearer ${args.token}` },
      body,
      Math.min(20, args.n),
      concurrency
    );

    const direct = await runLeg(`${args.upstream}/v1/messages`, common, body, args.n, concurrency);
    const gateway = await runLeg(
      `${args.gateway}/v1/messages`,
      { ...common, authorization: `Bearer ${args.token}` },
      body,
      args.n,
      concurrency
    );
    results.push({
      concurrency,
      direct,
      gateway,
      deltaTtfbP95: gateway.ttfb.p95 - direct.ttfb.p95,
      deltaTotalP95: gateway.total.p95 - direct.total.p95,
    });
  }

  const { token: _token, json: _json, ...rest } = args;
  return { args: rest, results };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    process.stderr.write('bench-llm-router: --token is required (a router token, rt_…)\n');
    process.exit(2);
  }
  const report = await runBench(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(`${formatTable(report)}\n`);
  }
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  return import.meta.url === new URL(`file://${scriptPath}`).href;
}

if (isMainModule()) {
  void main();
}
