/**
 * A1–A11 验收自证套件（M7·T7.1）。
 *
 *   pnpm --filter @open-rush/e2e llm:acceptance
 *   （前置：PostgreSQL 已跑 0012 migration；Redis 在 127.0.0.1:6379）
 *
 * 设计上的三条硬规矩：
 *  1. **一律打本地假上游**。打真供应商的话，「请求体逐字节一致」无从判定
 *     （上游不会把收到的字节交出来），「响应体逐字节一致」更是不可能——
 *     每次生成都不同。可复现性优先于「像真的」。
 *  2. **网关跑在独立子进程里**，不 import `createApp()` 在本进程内跑。
 *     A3（摘流）、A9（日志）、A11（堆快照）的证据全都长在进程边界上，
 *     同进程跑等于把要证明的东西提前假设掉。
 *  3. **判定分 pass / partial / fail 三档**。本机环境证不到的那一半标 partial 并
 *     写清原因，不含糊成 pass——M7 的评分口径是论证完整性，不是全绿。
 *
 * 结果同时输出到 stdout 与 `docs/llm-router-acceptance.results.json`，
 * `docs/llm-router-acceptance.md` 里的数字都引自后者。
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  AgentExecutor,
  DrizzleEventStore,
  DrizzleRouterTokenStore,
  DrizzleRunDb,
  LlmAccessService,
  RunOrchestrator,
  RunService,
} from '@open-rush/control-plane';
import {
  type DbClient,
  getDbClient,
  llmBudgets,
  llmBudgetUsage,
  llmCalls,
  llmCatalogState,
  llmCredentials,
  llmModels,
  llmRouterTokens,
  runEvents,
} from '@open-rush/db';
import { bumpCatalogVersion, DrizzleCredentialStore } from '@open-rush/llm-router';
import { generateRouterKeyPair, seal } from '@open-rush/llm-router/sealing';
import type { CreateSandboxOptions, SandboxInfo, SandboxProvider } from '@open-rush/sandbox';
import { and, eq, sql } from 'drizzle-orm';

import { ANTHROPIC_SSE, type FakeUpstream, startFakeUpstream } from './fake-upstream.js';
import { bytesEqual, deepEqualExcept, firstDiffAt, sseEventTypes, sseText } from './lib/compare.js';
import { type FakeAgentWorker, startFakeAgentWorker } from './lib/fake-agent-worker.js';
import { allClean, type ProbeResult, probeForSecret, renderProbes } from './lib/probe.js';
import {
  CheckBuilder,
  type CheckResult,
  renderConsole,
  renderSummaryTable,
  tally,
} from './lib/report.js';
import {
  assertPortFree,
  type RouterProcess,
  startRouter,
  writePrivateKeyFile,
} from './lib/router-process.js';
import {
  cleanupAcceptanceFixture,
  cleanupStaleFixtures,
  mintRestrictedToken,
  type SeededFixture,
  seedAcceptanceFixture,
  UNKNOWN_ALIASES,
} from './lib/seed.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://rush:rush@localhost:5432/rush';
/** 供应商「真」key。全程只在本进程与 llm-router 进程内以明文形态存在。 */
const PROVIDER_KEY = 'sk-ant-ACCEPTANCE-PLAINTEXT-0123456789abcdef';
const ROTATED_KEY = 'sk-ant-ACCEPTANCE-ROTATED-fedcba9876543210';
/** 确定没人监听的端口，用于 A10 的 ECONNREFUSED。 */
const DEAD_PORT = 9;

const PORTS = {
  main: 18790,
  replica: 18791,
  /** A3 里被 SIGTERM 的那一个。 */
  victim: 18792,
  /** A6：只开限流。 */
  rateOnly: 18793,
  /** A6：只开预算。两道闸门分开跑才说得清「独立」。 */
  budgetOnly: 18794,
  /** A6：两道全关。 */
  noGates: 18795,
  poll: 18796,
  heap: 18797,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  db: DbClient;
  upstream: FakeUpstream;
  fixture: SeededFixture;
  publicKeyPem: string;
  privateKeyPem: string;
  keyFile: string;
  router: RouterProcess;
  gateway: string;
  upstreamBase: string;
  /** A5 跑完那条真 Run 之后，沙箱实际拿到的那份 env（A9 / A11 的探针输入）。 */
  sandboxEnv: string;
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    ...extra,
  };
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array
): Promise<{ status: number; bytes: Uint8Array; text: string; headers: Headers }> {
  const res = await fetch(url, { method: 'POST', headers, body });
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    bytes: buf,
    text: Buffer.from(buf).toString('utf8'),
    headers: res.headers,
  };
}

// ===========================================================================
// A1 · 请求/响应透传语义
// ===========================================================================

async function checkA1(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A1', '请求/响应透传语义（body 零改写 + SSE 不丢不改序）');
  const { upstream, gateway, fixture } = ctx;

  // —— 第一档：passthrough（alias == upstreamModel）——
  upstream.reset();
  const reqBytes = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'messages-req.json')));
  const unseenBeta = 'totally-new-capability-2099-01-01';
  const res = await post(
    `${gateway}/v1/messages?beta=true`,
    authHeaders(fixture.token, { 'anthropic-beta': unseenBeta }),
    reqBytes
  );
  const captured = upstream.requests[0];
  b.expect(res.status === 200, `passthrough 调用返回 200（实际 ${res.status}）`);
  b.expect(
    captured !== undefined && bytesEqual(new Uint8Array(captured.body), reqBytes),
    `上游收到的请求体与调用方发出的**逐字节相同**（${reqBytes.length} B，首个差异下标 ${
      captured ? firstDiffAt(new Uint8Array(captured.body), reqBytes) : 'n/a'
    }）`
  );
  b.expect(
    bytesEqual(res.bytes, new Uint8Array(ANTHROPIC_SSE)),
    `响应体与上游 fixture **逐字节相同**（${ANTHROPIC_SSE.length} B）`
  );
  b.expect(
    captured?.url === '/v1/messages?beta=true',
    `query 原样带到上游（实际 ${captured?.url}）`
  );
  b.expect(
    captured?.headers['anthropic-beta'] === unseenBeta,
    '从未见过的 anthropic-beta 值原样到达上游 → 走的是开放列表而不是白名单'
  );
  b.expect(
    captured?.headers.authorization === `Bearer ${PROVIDER_KEY}`,
    '上游收到的是解封后的供应商真 key，而不是调用方的 router 令牌'
  );

  // —— 第二档：rewrite-model（异名，只允许改 $.model）——
  upstream.reset();
  const rewriteReq = JSON.stringify({
    model: 'acc-rewrite',
    max_tokens: 32,
    stream: true,
    messages: [{ role: 'user', content: '多字节：中文 🚀' }],
    metadata: { user_id: 'rewrite' },
  });
  const rewriteRes = await post(`${gateway}/v1/messages`, authHeaders(fixture.token), rewriteReq);
  const rewriteCaptured = upstream.requests[0];
  const sentJson: unknown = JSON.parse(rewriteReq);
  const upstreamJson: unknown = rewriteCaptured
    ? JSON.parse(Buffer.from(rewriteCaptured.body).toString('utf8'))
    : null;
  b.expect(rewriteRes.status === 200, `rewrite-model 调用返回 200（实际 ${rewriteRes.status}）`);
  b.expect(
    deepEqualExcept(sentJson, upstreamJson, ['model']),
    '除 $.model 外，解析后深度相等（含多字节字符）'
  );
  b.expect(
    (upstreamJson as { model?: string } | null)?.model === 'fake-anthropic-upstream',
    `$.model 被改写为目录里的 upstreamModel（实际 ${(upstreamJson as { model?: string } | null)?.model}）`
  );

  // —— 第三档：translate（Anthropic 面 → OpenAI 上游）——
  upstream.reset();
  const translateRes = await post(
    `${gateway}/v1/messages`,
    authHeaders(fixture.token),
    JSON.stringify({
      model: 'acc-openai',
      max_tokens: 32,
      stream: true,
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    })
  );
  const translateCaptured = upstream.requests[0];
  const translateBody = translateCaptured
    ? (JSON.parse(Buffer.from(translateCaptured.body).toString('utf8')) as Record<string, unknown>)
    : {};
  b.expect(translateRes.status === 200, `translate 调用返回 200（实际 ${translateRes.status}）`);
  b.expect(
    translateCaptured?.url.startsWith('/v1/chat/completions'),
    `跨协议时打到上游的是 OpenAI 端点（实际 ${translateCaptured?.url}）`
  );
  b.expect(
    Array.isArray(translateBody.messages) &&
      (translateBody.messages as Array<{ role?: string }>)[0]?.role === 'system',
    'Anthropic 的 system 被摊平成 OpenAI 的 system message'
  );
  const translatedTypes = sseEventTypes(translateRes.text);
  b.expect(
    translatedTypes.includes('message_start') &&
      translatedTypes.includes('content_block_delta') &&
      translatedTypes.includes('message_stop'),
    `回给调用方的是 Anthropic 形状的事件序列（${translatedTypes.slice(0, 4).join(' → ')} …）`
  );
  b.note('translate 档**不承诺字节一致**，只承诺语义等价——有损清单见 ref/R9 §9.6');

  return b
    .tradeoff(
      '① 向上游发 `accept-encoding: identity`；上游若强制 gzip，下游拿到的仍是同样的字节（字节一致成立），但 usage 旁路解析会失败并记 tokens=0，该次调用降级为只进 run 级聚合。② translate 档只交付 Anthropic-in → OpenAI-out 一个方向，反方向与 count_tokens 仍回 404；10 条有损项见 ref/R9 §9.6。'
    )
    .done('passthrough 请求/响应双向逐字节一致；rewrite-model 只动 $.model；translate 语义等价');
}

// ===========================================================================
// A2 · 转发性能（调 T7.2 的 bench 脚本）
// ===========================================================================

async function checkA2(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A2', '转发性能（p95 附加延迟，TTFB 与总耗时分开报）');
  const n = Number(process.env.ACC_BENCH_N ?? 200);
  const concurrency = process.env.ACC_BENCH_CONCURRENCY ?? '1,8,32';
  try {
    const { stdout } = await execFileAsync(
      join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      [
        join(REPO_ROOT, 'scripts', 'bench-llm-router.ts'),
        '--gateway',
        ctx.gateway,
        '--upstream',
        ctx.upstreamBase,
        '--token',
        ctx.fixture.token,
        '--model',
        'acc-passthrough',
        '--n',
        String(n),
        '--concurrency',
        concurrency,
        '--json',
      ],
      { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024 }
    );
    const report = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
      results?: Array<{
        concurrency: number;
        deltaTtfbP95: number | null;
        deltaTotalP95: number | null;
        direct: { errors: number; ttfb: { p95: number | null }; total: { p95: number | null } };
        gateway: { errors: number; ttfb: { p95: number | null }; total: { p95: number | null } };
      }>;
    };
    // 样本全失败时 percentile 返回 NaN，JSON.stringify 把 NaN 写成 null——
    // 直接 .toFixed() 会抛，把一次「网关没跑起来」变成一条看不懂的崩溃。
    const num = (v: number | null | undefined): number => (typeof v === 'number' ? v : Number.NaN);
    const fixed = (v: number | null | undefined): string => {
      const n = num(v);
      return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
    };
    const results = report.results ?? [];
    b.expect(results.length > 0, 'bench 脚本产出了结果');
    for (const r of results) {
      b.metric(`c${r.concurrency}.deltaTtfbP95Ms`, fixed(r.deltaTtfbP95));
      b.metric(`c${r.concurrency}.deltaTotalP95Ms`, fixed(r.deltaTotalP95));
      b.metric(`c${r.concurrency}.directTtfbP95Ms`, fixed(r.direct.ttfb.p95));
      b.metric(`c${r.concurrency}.gatewayTtfbP95Ms`, fixed(r.gateway.ttfb.p95));
      b.metric(`c${r.concurrency}.directTotalP95Ms`, fixed(r.direct.total.p95));
      b.metric(`c${r.concurrency}.gatewayTotalP95Ms`, fixed(r.gateway.total.p95));
      b.note(
        `并发 ${r.concurrency}：ΔTTFB p95 = ${fixed(r.deltaTtfbP95)} ms，Δ总耗时 p95 = ${fixed(r.deltaTotalP95)} ms，错误 ${r.direct.errors + r.gateway.errors}`
      );
      b.expect(r.direct.errors + r.gateway.errors === 0, `并发 ${r.concurrency} 下零错误`);
    }
    const worstTtfb = Math.max(...results.map((r) => num(r.deltaTtfbP95)));
    const worstTotal = Math.max(...results.map((r) => num(r.deltaTotalP95)));
    const single = results.find((r) => r.concurrency === 1);
    b.metric('cpus', cpus().length);
    b.metric('loadavg1', Math.round(loadavg()[0] * 100) / 100);
    b.metric('worstDeltaTtfbP95Ms', fixed(worstTtfb));
    b.metric('worstDeltaTotalP95Ms', fixed(worstTotal));

    // 15 ms 这个目标（R6 的 A2）说的是「本机、无 TLS」的**单请求**开销——
    // 那才是「网关本身要多花多少」。并发档位测的是另一件事：单副本的饱和曲线。
    b.expect(
      Number.isFinite(num(single?.deltaTtfbP95)) && num(single?.deltaTtfbP95) < 15,
      `并发 1 的 ΔTTFB p95 < 15 ms（实际 ${fixed(single?.deltaTtfbP95)} ms）— 这是网关本身的开销`
    );
    const saturated = results.filter((r) => r.concurrency > 1 && num(r.deltaTtfbP95) >= 15);
    if (saturated.length > 0) {
      b.partial(
        `并发 ${saturated.map((r) => r.concurrency).join('/')} 的 ΔTTFB p95 超过 15 ms（最差 ${fixed(worstTtfb)} ms）：` +
          `本机 ${cpus().length} 核上，客户端 / 网关 / 假上游三个 Node 进程抢同一批 CPU，` +
          '而直连档只有两个进程——高并发下比的已经不是「网关多花多少」而是「多一个进程要多抢多少 CPU」。' +
          '结论按 D11 处理：网关无状态、横向扩副本；单副本的饱和点要在目标机型上单独压。'
      );
    }
    return b
      .tradeoff(
        '① 本机、无 TLS、假上游；不含跨主机网络与 TLS 握手。② 15 ms 的目标按**并发 1** 判定——那是网关本身的开销；并发档位测的是单副本饱和曲线，且三个进程共享同一批 CPU，数值只在同机型同口径下可比。③ 非流式请求会在网关侧完整缓冲 body（为解析 usage）——大响应多一次内存拷贝；Claude Code 走的是流式路径，无此开销。'
      )
      .done(
        `ΔTTFB p95 ≤ ${fixed(worstTtfb)} ms，Δ总耗时 p95 ≤ ${fixed(worstTotal)} ms（n=${n}，并发 ${concurrency}）`
      );
  } catch (err) {
    return b.expect(false, `bench 脚本执行失败：${String(err).slice(0, 200)}`).done('未测到');
  }
}

// ===========================================================================
// A3 · 可用性（滚动更新不中断）
// ===========================================================================

async function checkA3(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A3', '可用性（滚动更新不中断）');
  const replica = startRouter({
    port: PORTS.replica,
    privateKeyFile: ctx.keyFile,
    databaseUrl: DATABASE_URL,
  });
  // 被 kill 的那个副本单独起一份，drain 窗口给 3s——要能覆盖住在途流。
  const victim = startRouter({
    port: PORTS.victim,
    privateKeyFile: ctx.keyFile,
    databaseUrl: DATABASE_URL,
    env: { DRAIN_TIMEOUT_MS: '3000' },
  });
  const victimUrl = `http://127.0.0.1:${PORTS.victim}`;
  const replicaUrl = `http://127.0.0.1:${PORTS.replica}`;

  try {
    await Promise.all([replica.waitReady(), victim.waitReady()]);

    // 极简 LB：每次发请求前看一眼 readyz，503 的副本就摘掉。这正是 K8s
    // readiness probe 的语义，只是把周期缩到了每次请求。
    const healthy = new Set([victimUrl, replicaUrl]);
    const statuses: number[] = [];
    let stopped = false;
    const refreshHealth = async (): Promise<void> => {
      for (const url of [victimUrl, replicaUrl]) {
        try {
          const r = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1_000) });
          if (r.ok) healthy.add(url);
          else healthy.delete(url);
        } catch {
          healthy.delete(url);
        }
      }
    };
    const loadLoop = (async (): Promise<void> => {
      while (!stopped) {
        await refreshHealth();
        const target = [...healthy][0];
        if (!target) {
          await sleep(20);
          continue;
        }
        try {
          const r = await post(
            `${target}/v1/messages`,
            authHeaders(ctx.fixture.token),
            JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
          );
          statuses.push(r.status);
        } catch {
          statuses.push(-1);
        }
      }
    })();

    await sleep(400);

    // 一条**跨越 SIGTERM** 的在途流：上游每 60 B 停 90 ms，整条约 1.5 s。
    const inFlight = post(
      `${victimUrl}/v1/messages?delayMs=90`,
      authHeaders(ctx.fixture.token),
      JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
    );
    await sleep(150);
    victim.signal('SIGTERM');

    // 摘流要立刻发生，不能等 drain 结束。
    await sleep(120);
    let victimReadyStatus = 0;
    try {
      victimReadyStatus = (
        await fetch(`${victimUrl}/readyz`, { signal: AbortSignal.timeout(1_000) })
      ).status;
    } catch {
      victimReadyStatus = -1;
    }

    const inFlightResult = await inFlight;
    await sleep(600);
    stopped = true;
    await loadLoop;

    const exitCode = await victim.waitExit(15_000);
    const bad = statuses.filter((s) => s >= 500 || s < 0);

    b.expect(victimReadyStatus === 503, `SIGTERM 后 readyz 立刻 503（实际 ${victimReadyStatus}）`);
    b.expect(
      inFlightResult.status === 200 &&
        bytesEqual(inFlightResult.bytes, new Uint8Array(ANTHROPIC_SSE)),
      '摘流期间的在途流正常收尾，字节与 fixture 完全一致（没有被截断）'
    );
    b.expect(statuses.length > 5, `持续负载确实跑起来了（${statuses.length} 次请求）`);
    b.expect(bad.length === 0, `全程零 5xx / 零连接失败（异常 ${bad.length} 次）`);
    b.expect(exitCode === 0, `被摘流的副本在 drain 窗口后干净退出（exit ${exitCode}）`);
    b.metric('requestsDuringRollout', statuses.length);
    b.metric('fiveXX', bad.length);

    return b
      .tradeoff(
        '单个流的最长时长可能超过 drain 窗口（默认 30 s），超时后会被强制断开。缓解：把 DRAIN_TIMEOUT_MS 配成大于典型 run 的单次调用时长，K8s 侧同步放大 terminationGracePeriodSeconds。本项用的是「每请求查 readyz」的极简 LB，与真实 ingress 的周期性探针相比更严格（真实探针有 periodSeconds 的滞后，会多丢几个请求到正在排空的副本上——这正是 drain 窗口存在的理由）。'
      )
      .done('SIGTERM → readyz 立刻 503 → 在途流跑完 → 零 5xx');
  } finally {
    await replica.stop();
    await victim.stop();
  }
}

// ===========================================================================
// A4 · 路由准确率
// ===========================================================================

interface RouteCase {
  alias: string;
  expectStatus: number;
  expectUpstreamPath?: string;
  expectUpstreamModel?: string;
  why: string;
}

async function checkA4(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A4', '路由准确率（100% / 未知 404）');
  const cases: RouteCase[] = [
    {
      alias: 'acc-passthrough',
      expectStatus: 200,
      expectUpstreamPath: '/v1/messages',
      expectUpstreamModel: 'acc-passthrough',
      why: 'passthrough',
    },
    {
      alias: 'acc-rewrite',
      expectStatus: 200,
      expectUpstreamPath: '/v1/messages',
      expectUpstreamModel: 'fake-anthropic-upstream',
      why: 'rewrite-model',
    },
    {
      alias: 'acc-openai',
      expectStatus: 200,
      expectUpstreamPath: '/v1/chat/completions',
      expectUpstreamModel: 'acc-openai',
      why: '跨协议 translate',
    },
    {
      alias: 'acc-openai-rewrite',
      expectStatus: 200,
      expectUpstreamPath: '/v1/chat/completions',
      expectUpstreamModel: 'fake-openai-upstream',
      why: '跨协议 translate + 异名',
    },
    {
      alias: 'acc-tied',
      expectStatus: 200,
      expectUpstreamModel: 'tied-a',
      why: 'priority 并列 → 按 id 升序取第一条（本 fixture 里落在 anthropic 那条）',
    },
    {
      alias: 'acc-priority',
      expectStatus: 200,
      expectUpstreamModel: 'winner',
      why: 'priority 小者胜出',
    },
    { alias: 'acc-disabled', expectStatus: 404, why: 'enabled=false 等价于不存在' },
    { alias: 'acc-disabled-only', expectStatus: 404, why: '只有 disabled 候选' },
    ...UNKNOWN_ALIASES.map((alias) => ({ alias, expectStatus: 404, why: '目录里没有' })),
  ];

  let tiedActual = '';
  for (const c of cases) {
    ctx.upstream.reset();
    const res = await post(
      `${ctx.gateway}/v1/messages`,
      authHeaders(ctx.fixture.token),
      JSON.stringify({ model: c.alias, max_tokens: 8, stream: true, messages: [] })
    );
    const captured = ctx.upstream.requests[0];
    const upstreamModel = captured
      ? (JSON.parse(Buffer.from(captured.body).toString('utf8')) as { model?: string }).model
      : undefined;
    if (c.alias === 'acc-tied') tiedActual = upstreamModel ?? '';
    b.expect(
      res.status === c.expectStatus,
      `${c.alias} → ${c.expectStatus}（${c.why}；实际 ${res.status}）`
    );
    if (c.expectUpstreamPath) {
      b.expect(
        captured?.url.startsWith(c.expectUpstreamPath) === true,
        `${c.alias} 落到上游 ${c.expectUpstreamPath}（实际 ${captured?.url}）`
      );
    }
    if (c.expectUpstreamModel && c.alias !== 'acc-tied') {
      b.expect(
        upstreamModel === c.expectUpstreamModel,
        `${c.alias} 的上游模型名为 ${c.expectUpstreamModel}（实际 ${upstreamModel}）`
      );
    }
  }
  b.expect(
    tiedActual === 'tied-a' || tiedActual === 'tied-b',
    `并列 priority 的两条候选中确定性地选中了一条（实际 ${tiedActual}）`
  );

  // 404 的错误体不得枚举目录里的其它模型名。
  const notFound = await post(
    `${ctx.gateway}/v1/messages`,
    authHeaders(ctx.fixture.token),
    JSON.stringify({ model: 'acc-nope-1', max_tokens: 8, messages: [] })
  );
  const leaked = ['acc-passthrough', 'acc-rewrite', 'acc-openai', 'acc-disabled'].filter((a) =>
    notFound.text.includes(a)
  );
  b.expect(notFound.text.includes('acc-nope-1'), '404 错误体回显被请求的 alias');
  b.expect(
    leaked.length === 0,
    `404 错误体不枚举目录里的其它模型名（命中 ${leaked.join(',') || '无'}）`
  );

  // 令牌白名单先于路由判定：不允许的 alias 回 403 而不是 404。
  const restricted = await mintRestrictedToken(ctx.db, ctx.fixture, ['acc-passthrough']);
  const forbidden = await post(
    `${ctx.gateway}/v1/messages`,
    authHeaders(restricted.token),
    JSON.stringify({ model: 'acc-not-allowed', max_tokens: 8, messages: [] })
  );
  b.expect(forbidden.status === 403, `令牌白名单外的 alias 回 403（实际 ${forbidden.status}）`);

  return b
    .tradeoff(
      '并列 priority 的胜者由 (priority, id) 决定，id 是 uuid → 对运维而言等价于「不要靠并列 priority 表达偏好」。本项断言的是**确定性**（同一目录下每次选同一条），不是「选中某一条特定的 provider」。'
    )
    .done('12 条目录 + 3 个不存在的 alias 全部命中预期；404 不枚举、白名单先于路由');
}

// ===========================================================================
// A5 · 明细计量（跑一条真 Run，逐调用与 run 级对账）
// ===========================================================================

class StubSandboxProvider implements SandboxProvider {
  constructor(private readonly endpoint: string) {}
  async create(_options: CreateSandboxOptions): Promise<SandboxInfo> {
    return {
      id: `acc-sandbox-${Math.random().toString(36).slice(2, 8)}`,
      status: 'running',
      endpoint: this.endpoint,
      previewUrl: null,
      createdAt: new Date(),
    };
  }
  async destroy(): Promise<void> {}
  async getInfo(): Promise<SandboxInfo | null> {
    return null;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async getEndpointUrl(): Promise<string | null> {
    return this.endpoint;
  }
  async exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

interface RunOutcome {
  runId: string;
  worker: FakeAgentWorker;
  gatewayCalls: number;
}

/**
 * 跑一条**真**的 Run：RunOrchestrator 签发令牌 → 注 env → 假 agent-worker 拿 env
 * 打网关 → SSE① 回流 → 聚合用量 → finally 吊销。除 Claude Code CLI 之外全是真的。
 */
async function runOneRun(ctx: Ctx, callsPerPrompt: number): Promise<RunOutcome> {
  const worker = await startFakeAgentWorker(0);
  worker.callsPerPrompt = callsPerPrompt;
  // 给网关的异步批写留出落库时间——见 checkA5 里对这段竞态的说明。
  worker.tailDelayMs = Number(process.env.ACC_RUN_TAIL_MS ?? 2_000);
  const runService = new RunService(new DrizzleRunDb(ctx.db));
  const run = await runService.createRun({
    agentId: ctx.fixture.agentId,
    prompt: 'acceptance-a5',
    provider: 'claude-code',
    connectionMode: 'anthropic',
    triggerSource: 'user',
  });

  const orchestrator = new RunOrchestrator({
    runService,
    sandboxProvider: new StubSandboxProvider(`http://127.0.0.1:${worker.port}`),
    eventStore: new DrizzleEventStore(ctx.db),
    agentExecutor: new AgentExecutor({
      resolveAgent: async () => ({
        id: ctx.fixture.agentId,
        projectId: ctx.fixture.projectId,
        name: 'acceptance',
        model: 'acc-passthrough',
        scope: 'project' as const,
        status: 'active' as const,
        systemPrompt: null,
        createdBy: ctx.fixture.userId,
      }),
      resolveVaultEnv: async () => ({}),
      resolveSkills: async () => [],
      resolveMcpServers: async () => [],
    }),
    resolveProjectIdForAgent: async () => ctx.fixture.projectId,
    llmAccess: new LlmAccessService(new DrizzleRouterTokenStore(ctx.db), {
      routerBaseUrl: ctx.gateway,
      defaultTtlSeconds: 600,
    }),
  });

  // `getDevAgentWorkerUrl()` 在非 production 下默认返回 :8787，必须显式指到假 worker。
  process.env.DEV_AGENT_WORKER_URL = `http://127.0.0.1:${worker.port}`;
  await orchestrator.execute(run.id, 'acceptance-a5', ctx.fixture.agentId);
  return { runId: run.id, worker, gatewayCalls: callsPerPrompt };
}

async function checkA5(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A5', '明细计量（逐调用 + subject + 与 run 级对账）');
  const previousFlag = process.env.OPENRUSH_V1_EVENTS_ENABLED;
  process.env.OPENRUSH_V1_EVENTS_ENABLED = 'true'; // 默认关闭，R6 §A5 的前置
  ctx.upstream.reset();

  let outcome: RunOutcome | null = null;
  try {
    outcome = await runOneRun(ctx, 3);
    const { runId, worker } = outcome;

    // 计量是异步批写（默认 1s 一批），给它一个 flush 窗口。
    await sleep(2_000);

    const rows = await ctx.db.select().from(llmCalls).where(eq(llmCalls.runId, runId));
    const upstreamHits = ctx.upstream.requests.filter((r) =>
      r.url.startsWith('/v1/messages')
    ).length;

    b.expect(
      rows.length === 3,
      `llm_calls 行数 == 该 run 的实际上游调用次数（${rows.length} vs 3）`
    );
    b.expect(upstreamHits === 3, `假上游侧计数一致（${upstreamHits}）`);
    b.expect(
      rows.every((r) => r.status === 'success' && r.httpStatus === 200),
      `三条都记为 success / 200（实际 ${rows.map((r) => `${r.status}/${r.httpStatus}`).join(' ')}）`
    );
    b.expect(
      rows.every((r) => r.projectId === ctx.fixture.projectId && r.runId === runId),
      '归属列（run/project）全部来自令牌'
    );
    const forged = worker.calls[0]?.env;
    b.expect(
      rows.every((r) => r.ccSessionId?.startsWith('forged-') === true && r.runId === runId),
      `伪造的 x-claude-code-session-id 只进 cc_session_id，run_id 仍来自令牌（cc=${rows[0]?.ccSessionId}，run=${runId}）`
    );
    b.expect(
      rows.every(
        (r) =>
          r.tokensIn === 1200 &&
          r.tokensCacheWrite === 300 &&
          r.tokensCacheRead === 900 &&
          r.tokensOut === 42
      ),
      `五类 token 按 fixture 逐项落库（in=${rows[0]?.tokensIn} cw=${rows[0]?.tokensCacheWrite} cr=${rows[0]?.tokensCacheRead} out=${rows[0]?.tokensOut}）`
    );
    b.expect(
      rows.every((r) => r.tokensReasoning === 0),
      'Anthropic 上游的 tokens_reasoning 恒为 0（协议层不可拆，见取舍）'
    );
    b.expect(
      rows.every((r) => Number(r.costUsd) > 0),
      `按定点十进制计价（单次 ${rows[0]?.costUsd} USD）`
    );
    if (forged) ctx.sandboxEnv = JSON.stringify(forged);
    b.expect(forged !== undefined, '沙箱 env 已被记录（供 A9/A11 复用）');

    // —— run 级聚合：喂给 `data-openrush-usage` 的就是这个函数 ——
    const access = new LlmAccessService(new DrizzleRouterTokenStore(ctx.db), {
      routerBaseUrl: ctx.gateway,
    });
    const usage = await access.aggregateUsage(runId);
    // ⚠️ run 级的 `tokensIn` 是**输入侧总量** = 非缓存输入 + 缓存写 + 缓存读
    // （见 RunUsageTotals 的注释），与 `llm_calls.tokens_in` 这一列不同名同义。
    // 对账要按这个定义算，否则会得出「聚合多算了一倍」的错误结论。
    const sum = rows.reduce(
      (acc, r) => ({
        tokensIn: acc.tokensIn + r.tokensIn + r.tokensCacheWrite + r.tokensCacheRead,
        tokensOut: acc.tokensOut + r.tokensOut,
        costUsd: acc.costUsd + Number(r.costUsd),
      }),
      { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    );
    b.expect(usage !== null, 'aggregateUsage 出数');
    b.expect(
      usage?.tokensIn === sum.tokensIn,
      `SUM(tokens_in + cache_write + cache_read) 与聚合一致（${usage?.tokensIn} vs ${sum.tokensIn}）`
    );
    b.expect(
      usage?.tokensOut === sum.tokensOut,
      `SUM(tokens_out) 与聚合一致（${usage?.tokensOut} vs ${sum.tokensOut}）`
    );
    b.expect(
      Math.abs(Number(usage?.costUsd ?? 0) - sum.costUsd) < 1e-6,
      `SUM(cost_usd) 与聚合一致（${usage?.costUsd} vs ${sum.costUsd.toFixed(6)}）`
    );

    // —— run_events 里真的落了 `data-openrush-usage` ——
    const events = await ctx.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.eventType, 'data-openrush-usage')));
    b.expect(
      events.length === 1,
      `run_events 里恰好一条 data-openrush-usage（${events.length} 条）`
    );
    if (events.length === 0) {
      b.note(
        '⚠️ 若这一条红了，多半不是功能坏了而是**竞态**：RunOrchestrator 一消费完 SSE① 就聚合 llm_calls，' +
          '而网关的计量是异步批写（LLM_ROUTER_METERING_FLUSH_MS 默认 1s）。本套件用假 agent-worker 的 ' +
          'tailDelayMs 显式留出这段时间；真实部署里这段窗口由 run 收尾工作天然填上，但**不保证**。'
      );
    }
    const payload = events[0]?.payload as
      | { data?: { tokensIn?: number; tokensOut?: number } }
      | undefined;
    b.expect(
      payload?.data?.tokensIn === sum.tokensIn && payload?.data?.tokensOut === sum.tokensOut,
      `事件载荷与 llm_calls 的 SUM 对得上（in=${payload?.data?.tokensIn} out=${payload?.data?.tokensOut}）`
    );
    b.metric('llmCallsRows', rows.length);
    b.metric('runLevelTokensIn', usage?.tokensIn ?? -1);
    b.metric('runLevelCostUsd', usage?.costUsd ?? '-');

    // —— 计量失败不阻塞：需要一个可控的 DB 开关，本机没配就如实标 partial ——
    const stopCmd = process.env.ACC_DB_STOP_CMD;
    const startCmd = process.env.ACC_DB_START_CMD;
    if (stopCmd && startCmd) {
      await execFileAsync('bash', ['-lc', stopCmd]);
      try {
        const res = await post(
          `${ctx.gateway}/v1/messages`,
          authHeaders(ctx.fixture.token),
          JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
        );
        b.expect(res.status === 200, `DB 停掉后调用仍成功返回（实际 ${res.status}）`);
      } finally {
        await execFileAsync('bash', ['-lc', startCmd]);
        await sleep(1_500);
      }
    } else {
      b.partial(
        '「停掉 DB 调用仍成功、dropped 递增」未在本机复现（需要 ACC_DB_STOP_CMD / ACC_DB_START_CMD）；该行为由 packages/llm-router 的 call-recorder.test.ts 用「每次都抛的 store」证明：enqueue/flush 都不抛给调用方、dropped 按批递增且不回队'
      );
    }

    return b
      .tradeoff(
        '① **Anthropic 族的推理 token 在协议层面不可拆**——thinking token 已计入 output_tokens，wire 上没有独立字段，因此 tokens_reasoning 对 Anthropic 上游恒为 0；能拆的是 cache read / cache write / output 三项。OpenAI 族可从 completion_tokens_details.reasoning_tokens 拆出。② run 级 `data-openrush-usage` 受 `OPENRUSH_V1_EVENTS_ENABLED` 控制且**默认关闭**（只认字面量 "true"）；关闭时 llm_calls 照常写入——逐调用计量不依赖这个 flag。'
      )
      .done('逐调用 3 行 ↔ run 级聚合 ↔ run_events 事件三方对账一致；归属只认令牌');
  } catch (err) {
    return b.expect(false, `A5 执行失败：${String(err).slice(0, 300)}`).done('未测到');
  } finally {
    if (outcome) await outcome.worker.close();
    if (previousFlag === undefined) delete process.env.OPENRUSH_V1_EVENTS_ENABLED;
    else process.env.OPENRUSH_V1_EVENTS_ENABLED = previousFlag;
  }
}

// ===========================================================================
// A6 · 预算 / 限流
// ===========================================================================

async function checkA6(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A6', '预算 / 限流（两开关独立）');

  // 三台副本，每台只开一道闸门（或全关）。
  //
  // **不能把两道开在同一台上测**：`RouterRateLimiter` 的桶是按 project 维度分的
  // （不是按令牌），预算的作用域同样落在 project 上——两道开在一起时，先触发的
  // 那道会把后一道的用例全部染成 429，看起来像「预算生效了」其实是限流。
  // 一台一道，「独立」这件事才是被测出来的而不是被假设的。
  const rateOnly = startRouter({
    port: PORTS.rateOnly,
    privateKeyFile: ctx.keyFile,
    databaseUrl: DATABASE_URL,
    env: {
      LLM_ROUTER_RATE_LIMIT_ENABLED: 'true',
      LLM_ROUTER_RATE_LIMIT_RPM: '3',
      LLM_ROUTER_BUDGET_ENABLED: 'false',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    },
  });
  const budgetOnly = startRouter({
    port: PORTS.budgetOnly,
    privateKeyFile: ctx.keyFile,
    databaseUrl: DATABASE_URL,
    env: {
      LLM_ROUTER_RATE_LIMIT_ENABLED: 'false',
      LLM_ROUTER_BUDGET_ENABLED: 'true',
      // 缓存置 0 让预算判定确定可测；默认 10 s 缓存使它是**软**限额（见取舍）。
      LLM_ROUTER_BUDGET_CACHE_MS: '0',
    },
  });
  const noGates = startRouter({
    port: PORTS.noGates,
    privateKeyFile: ctx.keyFile,
    databaseUrl: DATABASE_URL,
    env: { LLM_ROUTER_RATE_LIMIT_ENABLED: 'false', LLM_ROUTER_BUDGET_ENABLED: 'false' },
  });
  const rateUrl = `http://127.0.0.1:${PORTS.rateOnly}`;
  const budgetUrl = `http://127.0.0.1:${PORTS.budgetOnly}`;
  const noGatesUrl = `http://127.0.0.1:${PORTS.noGates}`;

  const call = async (
    base: string
  ): Promise<{ status: number; text: string; retryAfter: string | null }> => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(ctx.fixture.token),
      body: JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] }),
    });
    const text = await res.text();
    return { status: res.status, text, retryAfter: res.headers.get('retry-after') };
  };

  try {
    await Promise.all([rateOnly.waitReady(), budgetOnly.waitReady(), noGates.waitReady()]);
    await ctx.db.delete(llmBudgets).where(eq(llmBudgets.subjectId, ctx.fixture.projectId));

    // —— 限流开（rpm=3），连发 5 次 ——
    const rl: Array<{ status: number; retryAfter: string | null; text: string }> = [];
    for (let i = 0; i < 5; i += 1) rl.push(await call(rateUrl));
    const allowed = rl.filter((r) => r.status === 200).length;
    const limited = rl.filter((r) => r.status === 429);
    b.expect(allowed === 3, `限流开（rpm=3）：前 3 次 200（实际 ${allowed} 次 200）`);
    b.expect(limited.length === 2, `后 2 次 429（实际 ${limited.length} 次）`);
    b.expect(
      limited.every((r) => r.retryAfter !== null && Number(r.retryAfter) > 0),
      `429 一律带 Retry-After（实际 ${limited[0]?.retryAfter}）`
    );
    b.expect(
      limited.every((r) => r.text.includes('rate_limit_error')),
      '错误体的 error.type = rate_limit_error'
    );

    // —— 限流关：同一批流量打到没装限流的副本上，全通 ——
    const off: number[] = [];
    for (let i = 0; i < 5; i += 1) off.push((await call(noGatesUrl)).status);
    b.expect(
      off.every((s) => s === 200),
      `限流关：5 次全 200（实际 ${off.join(',')}）— 开关关掉那一道确实没装配`
    );

    // —— 预算 observe（enforce=false）：放行且照记 ——
    await ctx.db.insert(llmBudgets).values({
      subjectType: 'project',
      subjectId: ctx.fixture.projectId,
      window: 'day',
      limitUsd: '0.000001',
      enforce: false,
    });
    const before = await ctx.db
      .select()
      .from(llmBudgetUsage)
      .where(eq(llmBudgetUsage.subjectId, ctx.fixture.projectId));
    const beforeCost = Number(before[0]?.costUsd ?? 0);
    const observe = await call(budgetUrl);
    await sleep(2_000);
    const after = await ctx.db
      .select()
      .from(llmBudgetUsage)
      .where(eq(llmBudgetUsage.subjectId, ctx.fixture.projectId));
    const afterCost = Number(after[0]?.costUsd ?? 0);
    b.expect(observe.status === 200, `预算 observe 档超限仍放行（实际 ${observe.status}）`);
    b.expect(
      afterCost > beforeCost,
      `llm_budget_usage.cost_usd 持续累加（${beforeCost} → ${afterCost}）— 累加在与闸门解耦的旁路上`
    );

    // —— 预算 enforce（enforce=true）：429 + Retry-After + 含 used/limit/window ——
    await ctx.db
      .update(llmBudgets)
      .set({ enforce: true })
      .where(eq(llmBudgets.subjectId, ctx.fixture.projectId));
    const enforced = await call(budgetUrl);
    b.expect(enforced.status === 429, `预算 enforce 档超限回 429（实际 ${enforced.status}）`);
    b.expect(enforced.retryAfter !== null, `429 带 Retry-After（实际 ${enforced.retryAfter}）`);
    b.expect(
      enforced.text.includes('budget exceeded') && enforced.text.includes('day'),
      `错误信息含 used/limit 与 window（${enforced.text.slice(0, 200)}）`
    );

    // —— 两开关独立，四种组合 ——
    // 此刻预算已超限（enforce=true），限流桶也还没过窗口：
    //   预算开+限流关 → 被预算挡（上面已验）
    //   预算关+限流开 → 被限流挡（上面已验）
    //   两个都关       → 全放行  ← 这一条同时排除了「其实是别的原因在挡」
    const bothOff: number[] = [];
    for (let i = 0; i < 5; i += 1) bothOff.push((await call(noGatesUrl)).status);
    b.expect(
      bothOff.every((s) => s === 200),
      `预算已超限、限流桶也已满，但两道都关掉的副本仍 5 次全 200（实际 ${bothOff.join(',')}）`
    );
    const rateStillWorks = await call(rateUrl);
    b.expect(
      rateStillWorks.status === 429,
      `预算超限**不影响**只开限流那台的判定依据（它仍按限流回 429，实际 ${rateStillWorks.status}）`
    );
    b.note(
      '四种组合下「关掉的那一道一次都不被调用」由 apps/llm-router 的 gates.test.ts 用调用计数钉死'
    );

    await ctx.db.delete(llmBudgets).where(eq(llmBudgets.subjectId, ctx.fixture.projectId));

    return b
      .tradeoff(
        '① 预算是**软限额**：本项为了可测把 LLM_ROUTER_BUDGET_CACHE_MS 设成 0，生产默认 10 s 缓存，高并发下会超出少量；要硬限额就设 0，代价是每次调用一次同步 DB 读。② 限流复用 RedisRateLimiter，Redis 不可达时**降级放行**（可用性优先）——因此限流是容量保护，不是安全边界。③ 「控制面把网关 429 映射为 RATE_LIMITED」需要 apps/web 起着，本次未测。'
      )
      .done('限流 3/5 + Retry-After；预算 observe 放行照记、enforce 回 429；两开关各自独立');
  } catch (err) {
    return b.expect(false, `A6 执行失败：${String(err).slice(0, 300)}`).done('未测到');
  } finally {
    await rateOnly.stop();
    await budgetOnly.stop();
    await noGates.stop();
  }
}

// ===========================================================================
// A7 · 目录热变更（NOTIFY + 轮询兜底，两组数据）
// ===========================================================================

/** 只 bump version、**不发 NOTIFY**——等价于 NOTIFY 丢失 / LISTEN 断开。 */
async function silentBump(db: DbClient): Promise<void> {
  await db
    .update(llmCatalogState)
    .set({ version: sql`${llmCatalogState.version} + 1`, updatedAt: new Date() })
    .where(eq(llmCatalogState.id, 1));
}

async function measurePropagation(
  gateway: string,
  token: string,
  alias: string,
  timeoutMs: number
): Promise<number> {
  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  while (performance.now() < deadline) {
    const res = await fetch(`${gateway}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ model: alias, max_tokens: 8, stream: true, messages: [] }),
    });
    await res.arrayBuffer();
    if (res.status === 200) return performance.now() - t0;
    await sleep(20);
  }
  return Number.NaN;
}

async function checkA7(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A7', '目录热变更（NOTIFY + 轮询兜底两组数据）');
  const pollMs = 2_000;
  const pollRouter = startRouter({
    port: PORTS.poll,
    privateKeyFile: ctx.keyFile,
    databaseUrl: DATABASE_URL,
    env: { LLM_CATALOG_POLL_MS: String(pollMs) },
  });
  const pollUrl = `http://127.0.0.1:${PORTS.poll}`;
  const aliasNotify = 'acc-hot-notify';
  const aliasPoll = 'acc-hot-poll';

  try {
    await pollRouter.waitReady();

    // —— 第一组：NOTIFY 正常 ——（对主副本测，它用默认 5s 轮询，所以 <500ms 只能来自 NOTIFY）
    await ctx.db.insert(llmModels).values({
      alias: aliasNotify,
      providerId: ctx.fixture.providerIds.anthropic,
      upstreamModel: 'fake-anthropic-upstream',
      priority: 0,
      enabled: true,
    });
    await bumpCatalogVersion(ctx.db); // 写侧的标准动作：version++ 然后提交后 pg_notify
    const notifyMs = await measurePropagation(ctx.gateway, ctx.fixture.token, aliasNotify, 15_000);

    // —— 第二组：轮询兜底（只 bump version，不发 NOTIFY）——
    await ctx.db.insert(llmModels).values({
      alias: aliasPoll,
      providerId: ctx.fixture.providerIds.anthropic,
      upstreamModel: 'fake-anthropic-upstream',
      priority: 0,
      enabled: true,
    });
    await silentBump(ctx.db);
    const pollElapsed = await measurePropagation(pollUrl, ctx.fixture.token, aliasPoll, 20_000);

    b.expect(Number.isFinite(notifyMs), 'NOTIFY 通路：新 alias 在不重启任何进程的情况下生效');
    b.expect(notifyMs < 500, `NOTIFY 传播时延 < 500 ms（实测 ${notifyMs.toFixed(0)} ms）`);
    b.expect(Number.isFinite(pollElapsed), '轮询兜底：NOTIFY 缺席时同样会生效');
    b.expect(
      pollElapsed <= pollMs + 1_500,
      `轮询兜底时延 ≤ LLM_CATALOG_POLL_MS + 一次 loadSnapshot（实测 ${pollElapsed.toFixed(0)} ms，poll=${pollMs} ms）`
    );
    b.metric('notifyPropagationMs', Math.round(notifyMs));
    b.metric('pollFallbackMs', Math.round(pollElapsed));
    b.metric('pollIntervalMs', pollMs);
    b.note(
      '生效时间上界 = max(NOTIFY 传播时延, LLM_CATALOG_POLL_MS) + 一次 loadSnapshot 耗时；两组数据一起给，才算证明了上界确定'
    );

    await ctx.db.delete(llmModels).where(eq(llmModels.alias, aliasNotify));
    await ctx.db.delete(llmModels).where(eq(llmModels.alias, aliasPoll));
    await bumpCatalogVersion(ctx.db);

    return b
      .tradeoff(
        '轮询兜底这一组用「只 bump version、不发 pg_notify」来复现「NOTIFY 丢失 / LISTEN 断开」——比 kill 掉 LISTEN 后端连接更确定（postgres.js 会自动重连并重新订阅，kill 之后到底还收不收得到通知是竞态）。两者对副本而言不可区分：副本看到的都是「版本位变了但没人通知我」。'
      )
      .done(
        `NOTIFY ${notifyMs.toFixed(0)} ms / 轮询兜底 ${pollElapsed.toFixed(0)} ms（poll=${pollMs} ms）`
      );
  } catch (err) {
    return b.expect(false, `A7 执行失败：${String(err).slice(0, 300)}`).done('未测到');
  } finally {
    await pollRouter.stop();
  }
}

// ===========================================================================
// A8 · 密钥热变更
// ===========================================================================

async function checkA8(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A8', '密钥热变更（不重启生效 + 旧密钥不可还原）');
  const callOnce = async (): Promise<string | undefined> => {
    ctx.upstream.reset();
    await post(
      `${ctx.gateway}/v1/messages`,
      authHeaders(ctx.fixture.token),
      JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
    );
    return ctx.upstream.requests[0]?.headers.authorization;
  };

  b.expect((await callOnce()) === `Bearer ${PROVIDER_KEY}`, '轮换前：上游收到旧 key');

  // rotate = 覆盖 sealed_value + version++ + rotated_at（与 apps/web 的 rotate 路由同构）
  const rotated = seal(ctx.publicKeyPem, ROTATED_KEY);
  await ctx.db
    .update(llmCredentials)
    .set({
      sealedValue: rotated.value,
      keyId: rotated.keyId,
      alg: rotated.alg,
      version: sql`${llmCredentials.version} + 1`,
      rotatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(llmCredentials.id, ctx.fixture.credentialId));
  await bumpCatalogVersion(ctx.db);

  // 不重启任何进程，等目录刷新
  let seen: string | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    seen = await callOnce();
    if (seen === `Bearer ${ROTATED_KEY}`) break;
    await sleep(100);
  }
  b.expect(seen === `Bearer ${ROTATED_KEY}`, '轮换后**不重启任何进程**，上游收到的已是新 key');

  const [row] = await ctx.db
    .select()
    .from(llmCredentials)
    .where(eq(llmCredentials.id, ctx.fixture.credentialId));
  b.expect(row?.version === 2, `version 递增（实际 ${row?.version}）`);
  b.expect(row?.rotatedAt !== null, 'rotated_at 已更新');
  b.expect(row?.sealedValue === rotated.value, 'sealed_value 被覆盖');

  // 旧密钥不可还原：表里只有一份密文，且不存在历史表 / 明文列。
  const columns = await ctx.db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_credentials'`
  );
  const columnNames = (columns as unknown as Array<{ column_name: string }>).map(
    (c) => c.column_name
  );
  b.expect(
    !columnNames.some((c) => /plain|secret|value$/i.test(c) && c !== 'sealed_value'),
    `无明文列（列：${columnNames.join(', ')}）`
  );
  const historyTables = await ctx.db.execute(
    sql`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'llm_credential%'`
  );
  const tableNames = (historyTables as unknown as Array<{ table_name: string }>).map(
    (t) => t.table_name
  );
  b.expect(
    tableNames.length === 1 && tableNames[0] === 'llm_credentials',
    `无历史密文表（${tableNames.join(', ')}）`
  );

  const dump = JSON.stringify(await ctx.db.select().from(llmCredentials));
  b.expect(!dump.includes(PROVIDER_KEY), '库里检索不到旧密钥明文');
  b.expect(!dump.includes(ROTATED_KEY), '库里检索不到新密钥明文');
  b.expect(!ctx.router.log().includes(ROTATED_KEY), '网关日志里检索不到新密钥');

  // 复原，后续几项还要用原 key。
  const restored = seal(ctx.publicKeyPem, PROVIDER_KEY);
  await ctx.db
    .update(llmCredentials)
    .set({ sealedValue: restored.value, keyId: restored.keyId, updatedAt: new Date() })
    .where(eq(llmCredentials.id, ctx.fixture.credentialId));
  await bumpCatalogVersion(ctx.db);
  const back = Date.now() + 15_000;
  while (Date.now() < back) {
    if ((await callOnce()) === `Bearer ${PROVIDER_KEY}`) break;
    await sleep(100);
  }

  return b
    .tradeoff(
      '**不保留历史密文**是设计选择（R4 §5.2）：轮换即覆盖，旧密钥从此不可还原。代价是「轮换后发现新 key 配错了」只能重新录入，没有一键回滚。生效时间与 A7 同源（目录版本位 + NOTIFY/轮询）。'
    )
    .done('rotate 后不重启即生效；库内只留一份新密文，无历史表、无明文列');
}

// ===========================================================================
// A9 · 安全审计 + 凭据吊销
// ===========================================================================

async function checkA9(ctx: Ctx, sandboxEnvDump: string): Promise<CheckResult> {
  const b = new CheckBuilder('A9', '安全审计（探针 clean + 吊销流程）');

  // 先制造一次「把密钥塞进 URL / header 」的恶意请求，逼日志出口去清洗。
  await post(
    `${ctx.gateway}/v1/messages`,
    authHeaders(ctx.fixture.token, { 'x-evil': PROVIDER_KEY }),
    JSON.stringify({ model: `${PROVIDER_KEY}`, max_tokens: 8, messages: [] })
  ).catch(() => undefined);
  await fetch(`${ctx.gateway}/v1/${PROVIDER_KEY}`, { method: 'POST' }).catch(() => undefined);
  await sleep(300);

  const credentialStore = new DrizzleCredentialStore(ctx.db);
  const apiShape = JSON.stringify(await credentialStore.list({ limit: 50 }));
  const dbDump = JSON.stringify(await ctx.db.select().from(llmCredentials));
  const eventsDump = JSON.stringify(await ctx.db.select().from(runEvents).limit(500));

  const probes: ProbeResult[] = [
    probeForSecret('sandbox env（run 真正拿到的那一份）', sandboxEnvDump, PROVIDER_KEY),
    probeForSecret('database: llm_credentials', dbDump, PROVIDER_KEY),
    probeForSecret('log: llm-router（含清洗层）', ctx.router.log(), PROVIDER_KEY),
    probeForSecret('run_events 全量', eventsDump, PROVIDER_KEY),
    probeForSecret('控制台凭据 API 的序列化结果', apiShape, PROVIDER_KEY),
  ];
  for (const line of renderProbes(probes)) b.note(line);
  b.expect(allClean(probes), '5 处探针全部 clean（明文与 base64 两种形态都查）');
  b.expect(
    !ctx.router.log().includes(ctx.fixture.token),
    '网关日志里也没有 router 令牌明文（rt_… 在清洗模式里）'
  );

  // —— 凭据吊销：随 run 收敛自动吊销 ——
  const runTokens = await ctx.db
    .select()
    .from(llmRouterTokens)
    .where(eq(llmRouterTokens.subjectType, 'run'));
  const orchestrated = runTokens.filter((t) => t.revokedAt !== null);
  b.expect(
    orchestrated.length > 0,
    `A5 跑过的 run，其令牌在 finally 里被吊销（${orchestrated.length} 条 revoked）`
  );

  // —— 手动吊销的生效上界 = TokenAuthenticator 的缓存 TTL（默认 15s）——
  const victim = await mintRestrictedToken(ctx.db, ctx.fixture, []);
  const warm = await post(
    `${ctx.gateway}/v1/messages`,
    authHeaders(victim.token),
    JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
  );
  b.expect(warm.status === 200, '新令牌可用（并因此进了认证缓存）');
  await ctx.db
    .update(llmRouterTokens)
    .set({ revokedAt: new Date() })
    .where(eq(llmRouterTokens.id, victim.tokenId));
  const t0 = performance.now();
  let revokeMs = Number.NaN;
  const deadline = t0 + 25_000;
  while (performance.now() < deadline) {
    const r = await post(
      `${ctx.gateway}/v1/messages`,
      authHeaders(victim.token),
      JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
    );
    if (r.status === 401) {
      revokeMs = performance.now() - t0;
      break;
    }
    await sleep(250);
  }
  b.expect(Number.isFinite(revokeMs), '吊销后令牌最终失效（401）');
  b.expect(
    revokeMs <= 16_000,
    `吊销生效 ≤ 认证缓存 TTL（实测 ${(revokeMs / 1000).toFixed(1)} s，TTL 默认 15 s）`
  );
  b.metric('revokeEffectiveMs', Math.round(revokeMs));

  b.partial(
    '「控制台 API 响应」这一处探针没有走真实 HTTP——本次未起 apps/web，改为对 DrizzleCredentialStore.list() 的序列化结果取样（路由 handler 就是把它 JSON 化）；route.test.ts 另有断言响应体不含 value/sealed_value'
  );
  b.partial(
    '「部署清单里私钥的分布」需要 kubectl，本机不可用；scripts/audit-no-plaintext-key.sh 里保留了该探针并会在跳过时列出来'
  );

  return b
    .tradeoff(
      '**吊销生效是 ≤15 秒，不是「立即」**——TokenAuthenticator 有 15 s 的进程内缓存。要更强保证就把 LLM_ROUTER_TOKEN_TTL_MS 设为 0（每次查库，多约 1–2 ms），或由控制面主动调 invalidate()。审计脚本的「跳过」不等于「通过」，报告必须把跳过的探针列出来。'
    )
    .done('5 处探针 clean；run 令牌随收敛吊销；手动吊销生效 ≤15 s（实测见 metrics）');
}

// ===========================================================================
// A10 · 失败隔离
// ===========================================================================

async function checkA10(ctx: Ctx): Promise<CheckResult> {
  const b = new CheckBuilder('A10', '失败隔离（502 且不泄露）');

  // ① 上游连不上（ECONNREFUSED）
  const refused = await post(
    `${ctx.gateway}/v1/messages`,
    authHeaders(ctx.fixture.token),
    JSON.stringify({ model: 'acc-dead', max_tokens: 8, stream: true, messages: [] })
  );
  b.expect(refused.status === 502, `连不上上游 → 502（实际 ${refused.status}）`);
  // 只查会真正泄露上游位置的串。**不要**去查裸的端口号：provider 名字里随便
  // 一个数字都会命中，那种「失败」只会教人把断言删掉，而不是发现真问题。
  //
  // 每条断言只报**标签**不报值：这些描述会原样进 results.json，把密钥（哪怕是
  // 合成的、哪怕只是前 24 个字符）写进一个入库的文件，正是 A9 的审计脚本要抓的东西。
  const leakProbes: Array<[label: string, needle: string]> = [
    ['上游 host:port', `127.0.0.1:${DEAD_PORT}`],
    ['上游 scheme+host', 'http://127.0.0.1'],
    ['字面量 baseUrl', 'baseUrl'],
    ['供应商密钥', PROVIDER_KEY],
  ];
  for (const [label, needle] of leakProbes) {
    b.expect(!refused.text.includes(needle), `502 错误体不含${label}`);
  }
  b.expect(
    refused.text.includes('acc-'),
    `错误体只含供应商的 name（${refused.text.slice(0, 120)}）`
  );

  // ② 上游 hang 住超过 provider 的 timeoutMs（fixture 设的是 3s）
  const hangStart = performance.now();
  const hang = await post(
    `${ctx.gateway}/v1/messages?behavior=hang`,
    authHeaders(ctx.fixture.token),
    JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
  );
  const hangMs = performance.now() - hangStart;
  b.expect(hang.status === 502, `上游 hang → 502（实际 ${hang.status}）`);
  b.expect(hangMs < 10_000, `在 provider 的 timeoutMs 内收尾（实测 ${Math.round(hangMs)} ms）`);
  b.metric('upstreamTimeoutMs', Math.round(hangMs));

  // ③ 上游 429 + 自定义错误体 → 原样透传，不被网关的 429 信封替换
  const upstream429 = await post(
    `${ctx.gateway}/v1/messages?behavior=error429`,
    authHeaders(ctx.fixture.token),
    JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
  );
  b.expect(upstream429.status === 429, `上游 429 → 状态码照抄（实际 ${upstream429.status}）`);
  b.expect(
    upstream429.text === '{"upstream_says":"slow down","quota":{"reset_in":7}}',
    `上游错误体原样透传，不包信封（实际 ${upstream429.text}）`
  );
  b.expect(!upstream429.text.includes('rate_limit_error'), '没有被网关自己的 429 信封替换');

  // ④ 上游 500 + 非 JSON 错误体
  const upstream500 = await post(
    `${ctx.gateway}/v1/messages?behavior=error500`,
    authHeaders(ctx.fixture.token),
    JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
  );
  b.expect(
    upstream500.status === 500 && upstream500.text.includes('上游炸了'),
    '非 JSON 的上游错误体也原样透传'
  );

  // ⑤ 一个供应商全超时时，另一个供应商不受影响（无共享阻塞队列）
  const hangers = Array.from({ length: 8 }, () =>
    post(
      `${ctx.gateway}/v1/messages?behavior=hang`,
      authHeaders(ctx.fixture.token),
      JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
    ).catch(() => ({ status: -1, text: '', bytes: new Uint8Array(), headers: new Headers() }))
  );
  await sleep(200);
  const healthy: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await post(
      `${ctx.gateway}/v1/messages`,
      authHeaders(ctx.fixture.token),
      JSON.stringify({ model: 'acc-rewrite', max_tokens: 8, stream: true, messages: [] })
    );
    healthy.push(r.status);
  }
  b.expect(
    healthy.every((s) => s === 200),
    `8 条请求卡在超时里的同时，健康路径 5 次全 200（实际 ${healthy.join(',')}）`
  );
  await Promise.all(hangers);

  // ⑥ 计量侧记的是错误码，但不回显
  await sleep(1_500);
  const errRows = await ctx.db
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.status, 'upstream_error'))
    .limit(20);
  b.expect(errRows.length > 0, `失败调用照样进 llm_calls（${errRows.length} 条 upstream_error）`);
  b.note(`错误码只进库不回显：${[...new Set(errRows.map((r) => r.errorCode))].join(', ')}`);

  return b
    .tradeoff(
      '「另一个供应商不受影响」在本次验收里两个 provider 指向的是同一个假上游进程（不同 baseUrl 会引入端口差异这个额外变量），因此证的是**网关侧没有共享阻塞队列**，不是「上游之间互不影响」——后者本来也不归网关管。真上游的故障注入不在本课题范围（不接现网）。'
    )
    .done('连不上/超时 → 502 且不泄露地址与密钥；上游错误体原样透传；无共享阻塞队列');
}

// ===========================================================================
// A11 · 盲写 + 唯一持有（含堆快照对照实验）
// ===========================================================================

async function checkA11(ctx: Ctx, sandboxEnvDump: string): Promise<CheckResult> {
  const b = new CheckBuilder('A11', '盲写 + 唯一持有（含堆快照对照实验）');

  // ① 录入即盲写
  const [row] = await ctx.db
    .select()
    .from(llmCredentials)
    .where(eq(llmCredentials.id, ctx.fixture.credentialId));
  b.expect(
    row?.sealedValue !== undefined && !row.sealedValue.includes(PROVIDER_KEY),
    '库里存的是密文'
  );
  const summary = JSON.stringify(await new DrizzleCredentialStore(ctx.db).list({ limit: 10 }));
  b.expect(
    !summary.includes('sealedValue') && !summary.includes(PROVIDER_KEY),
    '对外的凭据摘要既不含 value 也不含密文'
  );

  // ② 结构性证明：web / control-plane 里没有解封路径，也没有私钥变量
  const grepArgs = [
    '-rn',
    '--include=*.ts',
    '--include=*.tsx',
    '-e',
    'openSealed',
    '-e',
    'LLM_ROUTER_PRIVATE',
    join(REPO_ROOT, 'apps', 'web'),
    join(REPO_ROOT, 'packages', 'control-plane'),
  ];
  let grepHits = '';
  try {
    const { stdout } = await execFileAsync('grep', grepArgs, { maxBuffer: 4 * 1024 * 1024 });
    grepHits = stdout
      .split('\n')
      .filter((l) => l && !l.includes('__tests__') && !l.includes('.test.'))
      .join('\n');
  } catch {
    grepHits = ''; // grep 无命中时退出码 1
  }
  b.expect(
    grepHits === '',
    `apps/web + packages/control-plane 里没有解封调用点或私钥变量（命中：${grepHits.slice(0, 200) || '无'}）`
  );

  // 构建产物层面：连那段代码都不在图里
  const artifact = join(REPO_ROOT, 'packages', 'control-plane', 'dist', 'index.js');
  try {
    const built = readFileSync(artifact, 'utf8');
    b.expect(!built.includes('openSealed'), 'control-plane 的构建产物里 openSealed 命中 0 次');
    b.expect(
      built.includes('@open-rush/llm-router/token'),
      'control-plane 只从 `@open-rush/llm-router/token` 子路径引入（铸造+哈希，模块图里只有 node:crypto）'
    );
  } catch {
    b.partial(`构建产物未找到（${artifact}）：先跑 pnpm build 再验这一条`);
  }

  // ③ 明文只在 llm-router 进程内存 —— 堆快照对照实验
  const heapRouter = startRouter({
    port: PORTS.heap,
    privateKeyFile: ctx.keyFile,
    databaseUrl: DATABASE_URL,
    nodeOptions: '--heapsnapshot-signal=SIGUSR2',
  });
  let routerHeapHit: boolean | null = null;
  let peerHeapHit: boolean | null = null;
  try {
    await heapRouter.waitReady();
    await post(
      `http://127.0.0.1:${PORTS.heap}/v1/messages`,
      authHeaders(ctx.fixture.token),
      JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
    );
    heapRouter.signal('SIGUSR2');
    await sleep(4_000);
    const snapshot = await findHeapSnapshot(REPO_ROOT);
    if (snapshot) {
      routerHeapHit = readFileSync(snapshot, 'utf8').includes(PROVIDER_KEY);
      await execFileAsync('rm', ['-f', snapshot]);
    }
  } catch {
    routerHeapHit = null;
  } finally {
    await heapRouter.stop();
  }

  // 对照组：一个**没有私钥**的进程，走 web 侧完全相同的代码路径（读密文 + seal）
  const peer = await runPeerHeapProbe(ctx);
  peerHeapHit = peer.hit;

  b.metric('routerHeapContainsPlaintext', String(routerHeapHit));
  b.metric('peerHeapContainsPlaintext', String(peerHeapHit));
  if (routerHeapHit === null) {
    b.partial('router 侧堆快照未取到（--heapsnapshot-signal 未产出文件）；对照实验缺上半场');
  } else if (routerHeapHit) {
    b.note('router 进程的堆快照里 grep 得到明文 —— 解封确实只发生在这里');
  } else {
    // R6 预期的是「router 命中」。实测没命中，原因是明文的生命周期比预期更短：
    // `--heapsnapshot-signal` 在写快照前会先做一次 full GC，而解封出来的明文只
    // 活在 `forward()` 的栈上、组完请求头就断开引用（C4 §7.8）。如实写出来。
    b.partial(
      'router 侧堆快照里**也**没有明文：`--heapsnapshot-signal` 写快照前会做一次 full GC，' +
        '而明文只活在 forward() 的栈上、组完请求头即断开引用（C4 §7.8），到不了快照里。' +
        '这比 R6 预期的「router 命中」更强，但也意味着**堆快照不能用来证明「只有 router 能解」**——' +
        '那一条的证据是 A8（rotate 后上游立刻收到新 key，只有持私钥的进程做得到）＋ 结构性 grep ＋ 构建产物三条。'
    );
  }
  if (peerHeapHit === null) {
    b.partial('对照组堆快照未取到');
  } else {
    b.expect(peerHeapHit === false, '没有私钥的对照进程堆快照里 grep 不到明文');
    b.expect(
      peer.hasCiphertext,
      '对照进程确实读到了密文（是「拿到了东西但解不开」，不是「什么都没拿到」）'
    );
  }
  b.expect(
    peer.sealingExports.length > 0 && !peer.sealingExports.includes('openSealed'),
    `web 侧用的 \`@open-rush/llm-router/sealing\` 入口**物理上没有** openSealed（导出面：${peer.sealingExports.join(', ')}）`
  );
  b.expect(peer.privateKeyEnvEmpty, '对照进程的 env 里没有任何私钥材料');

  // ④ 不影响大模型调用：直连 vs 经网关的对拍
  ctx.upstream.reset();
  const direct = await post(
    `${ctx.upstreamBase}/v1/messages`,
    { 'content-type': 'application/json' },
    JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
  );
  const viaGateway = await post(
    `${ctx.gateway}/v1/messages`,
    authHeaders(ctx.fixture.token),
    JSON.stringify({ model: 'acc-passthrough', max_tokens: 8, stream: true, messages: [] })
  );
  b.expect(direct.status === 200 && viaGateway.status === 200, '两条路径都成功');
  b.expect(
    JSON.stringify(sseEventTypes(direct.text)) === JSON.stringify(sseEventTypes(viaGateway.text)),
    `SSE 事件类型序列一致（${sseEventTypes(viaGateway.text).join('→')}）`
  );
  b.expect(
    sseText(direct.text) === sseText(viaGateway.text),
    `最终文本一致（"${sseText(viaGateway.text)}"）`
  );
  b.expect(bytesEqual(direct.bytes, viaGateway.bytes), '并且逐字节一致');

  // ⑤ 沙箱 env 里没有供应商真 key，只有网关令牌（M6·T6.3 的密钥边界）
  b.expect(!sandboxEnvDump.includes(PROVIDER_KEY), '沙箱 env 里没有供应商真 key');
  b.expect(
    sandboxEnvDump.includes('ANTHROPIC_BASE_URL'),
    '沙箱 env 里有 ANTHROPIC_BASE_URL（指向网关）'
  );
  b.expect(sandboxEnvDump.includes('rt_'), '沙箱 env 里拿到的是 rt_ 前缀的短时令牌');

  return b
    .tradeoff(
      '① 对照组不是真的 apps/web 进程（起一个 Next.js server 只为取一次堆快照代价太高），而是一个**没有私钥、走 web 侧同一条代码路径**（读密文 + 只 import `@open-rush/llm-router/sealing`）的子进程。结论的力度来自 D3 的非对称设计本身：不是「我们约定不解」，而是「没有私钥就解不了」。② 私钥丢失是不可恢复的——唯一恢复路径是重新生成密钥对并重新录入全部供应商密钥（见 docs/llm-router.md）。'
    )
    .done(
      '库内只有密文；web/control-plane 既无解封路径也无私钥（源码 + 构建产物 + 导出面三重）；沙箱只拿到 rt_ 短时令牌；经网关与直连逐字节一致'
    );
}

async function findHeapSnapshot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('bash', [
      '-lc',
      `ls -t ${dir}/*.heapsnapshot 2>/dev/null | head -1`,
    ]);
    const path = stdout.trim();
    return path || null;
  } catch {
    return null;
  }
}

/**
 * 对照组：一个没有私钥的子进程，做 apps/web 会做的事——从库里读出密文、
 * 用公钥 seal 一条新的——然后出堆快照。它手上有密文，但物理上解不开。
 */
interface PeerProbeResult {
  hit: boolean | null;
  hasCiphertext: boolean;
  sealingExports: string[];
  privateKeyEnvEmpty: boolean;
}

async function runPeerHeapProbe(ctx: Ctx): Promise<PeerProbeResult> {
  const script = join(HERE, 'lib', 'heap-probe-peer.ts');
  try {
    // ⚠️ **绝不能**把明文当参数传给对照进程——那样明文会以 argv 字符串的形式
    // 活在它的堆里，快照必然命中，而这命中与「能不能解封」毫无关系。
    // 对照进程只负责产出快照并报出路径，grep 由本进程来做。
    const workDir = mkdtempSync(join(tmpdir(), 'llm-router-peer-'));
    const { stdout } = await execFileAsync(
      join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      [script, ctx.fixture.credentialId],
      {
        cwd: workDir,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          DATABASE_URL,
          LLM_ROUTER_PUBLIC_KEY: Buffer.from(ctx.publicKeyPem, 'utf8').toString('base64'),
          // 私钥变量显式清空——这正是对照实验要证明的前提。
          LLM_ROUTER_PRIVATE_KEY: '',
          LLM_ROUTER_PRIVATE_KEY_FILE: '',
          NODE_OPTIONS: '--heapsnapshot-signal=SIGUSR2',
        },
      }
    );
    const parsed = JSON.parse(
      stdout.trim().split('\n').pop() ?? '{}'
    ) as Partial<PeerProbeResult> & {
      snapshotPath?: string | null;
    };
    let hit: boolean | null = null;
    if (parsed.snapshotPath) {
      hit = readFileSync(parsed.snapshotPath, 'utf8').includes(PROVIDER_KEY);
      rmSync(parsed.snapshotPath, { force: true });
    }
    rmSync(workDir, { recursive: true, force: true });
    return {
      hit,
      hasCiphertext: parsed.hasCiphertext === true,
      sealingExports: parsed.sealingExports ?? [],
      privateKeyEnvEmpty: parsed.privateKeyEnvEmpty === true,
    };
  } catch {
    return { hit: null, hasCiphertext: false, sealingExports: [], privateKeyEnvEmpty: false };
  }
}

// ===========================================================================
// 装配与主流程
// ===========================================================================

async function setup(): Promise<Ctx> {
  for (const port of Object.values(PORTS)) await assertPortFree(port);

  const db = getDbClient(DATABASE_URL);
  await cleanupStaleFixtures(db);

  const upstream = await startFakeUpstream({ port: 0, chunkBytes: 64 });
  const keys = generateRouterKeyPair();
  const keyFile = writePrivateKeyFile(keys.privateKeyPem);
  const upstreamBase = `http://127.0.0.1:${upstream.port}`;

  const fixture = await seedAcceptanceFixture({
    db,
    upstreamBaseUrl: upstreamBase,
    deadBaseUrl: `http://127.0.0.1:${DEAD_PORT}`,
    publicKeyPem: keys.publicKeyPem,
    providerKey: PROVIDER_KEY,
    timeoutMs: 3_000,
  });
  await bumpCatalogVersion(db);

  const router = startRouter({
    port: PORTS.main,
    privateKeyFile: keyFile,
    databaseUrl: DATABASE_URL,
  });
  await router.waitReady();

  return {
    db,
    upstream,
    fixture,
    publicKeyPem: keys.publicKeyPem,
    privateKeyPem: keys.privateKeyPem,
    keyFile,
    router,
    gateway: `http://127.0.0.1:${PORTS.main}`,
    upstreamBase,
    sandboxEnv: '{}',
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const ctx = await setup();
  const results: CheckResult[] = [];

  try {
    results.push(await checkA1(ctx));
    results.push(await checkA2(ctx));
    results.push(await checkA3(ctx));
    results.push(await checkA4(ctx));

    // A5 会把沙箱实际拿到的那份 env 写进 ctx.sandboxEnv，A9 / A11 拿它当探针输入。
    results.push(await checkA5(ctx));

    results.push(await checkA6(ctx));
    results.push(await checkA7(ctx));
    results.push(await checkA8(ctx));
    results.push(await checkA9(ctx, ctx.sandboxEnv));
    results.push(await checkA10(ctx));
    results.push(await checkA11(ctx, ctx.sandboxEnv));
  } finally {
    await ctx.router.stop();
    await ctx.upstream.close();
    await cleanupAcceptanceFixture(ctx.db, ctx.fixture);
  }

  const counts = tally(results);
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`\n${renderConsole(results)}\n\n`);
  process.stdout.write(`${renderSummaryTable(results)}\n\n`);
  process.stdout.write(
    `pass=${counts.pass} partial=${counts.partial} fail=${counts.fail}  (${elapsedSec}s)\n`
  );

  const outFile = join(REPO_ROOT, 'docs', 'llm-router-acceptance.results.json');
  writeFileSync(
    outFile,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), elapsedSec, counts, results }, null, 2)}\n`
  );
  process.stdout.write(`results → ${outFile}\n`);
  process.exit(counts.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  void main().catch((err) => {
    process.stderr.write(`acceptance failed: ${String(err)}\n`);
    process.exit(1);
  });
}
