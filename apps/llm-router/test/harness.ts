/**
 * 网关单测的公共夹具：内存目录 + 假认证器 + 假上游。
 *
 * 不起 PG、不造真令牌——那两条已经分别由 `packages/llm-router` 的
 * `drizzle-token-store.test.ts` 与 `drizzle-catalog-store.test.ts` 覆盖。
 * 这里要证的是**管线的接线**：认证 → 解析 → 白名单 → 路由 → 改写 → 转发。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type BudgetDecision,
  type CatalogCredential,
  type CatalogModel,
  type CatalogProvider,
  generateRouterKeyPair,
  InMemoryCallRecorder,
  type RateLimitDecision,
  type Snapshot,
  type Subject,
  seal,
} from '@open-rush/llm-router';
import { createApp } from '../src/app.js';
import type { RouterDeps } from '../src/deps.js';

export const KEYPAIR = generateRouterKeyPair();
export const UPSTREAM_SECRET = 'sk-upstream-super-secret-value';

export const SUBJECT: Subject = {
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
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
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

export function jsonResponder(status: number, body: string): UpstreamHandler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
}

export function sseResponder(chunks: string[], status = 200): UpstreamHandler {
  return async (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) {
      res.write(chunk);
      await new Promise((r) => setImmediate(r));
    }
    res.end();
  };
}

export function makeCredential(over: Partial<CatalogCredential> = {}): CatalogCredential {
  const envelope = seal(KEYPAIR.publicKeyPem, UPSTREAM_SECRET);
  return {
    id: 'cred-1',
    name: 'anthropic-prod',
    alg: envelope.alg,
    keyId: envelope.keyId,
    sealedValue: envelope.value,
    authStyle: 'bearer',
    authHeader: null,
    version: 1,
    ...over,
  };
}

export function makeModel(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'model-1',
    alias: 'claude-sonnet-4-6',
    providerId: 'prov-1',
    upstreamModel: 'claude-sonnet-4-6',
    priority: 0,
    displayName: 'Claude Sonnet 4.6',
    maxOutputTokens: 64_000,
    priceInputPerMtok: '3.000000',
    priceOutputPerMtok: '15.000000',
    priceCacheWritePerMtok: '3.750000',
    priceCacheReadPerMtok: '0.300000',
    priceReasoningPerMtok: '0.000000',
    ...over,
  };
}

export function makeSnapshot(opts: {
  models: CatalogModel[];
  providers: CatalogProvider[];
  credentials?: CatalogCredential[];
  version?: number;
}): Snapshot {
  const byAlias = new Map<string, CatalogModel[]>();
  for (const model of opts.models) {
    const list = byAlias.get(model.alias) ?? [];
    list.push(model);
    byAlias.set(model.alias, list);
  }
  for (const list of byAlias.values()) {
    list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }
  return {
    version: opts.version ?? 1,
    loadedAt: new Date(),
    byAlias,
    providers: new Map(opts.providers.map((p) => [p.id, p])),
    credentials: new Map((opts.credentials ?? [makeCredential()]).map((c) => [c.id, c])),
  };
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  deps: RouterDeps;
  recorder: InMemoryCallRecorder;
  upstream: FakeUpstream;
  setSubject(subject: Subject | null): void;
  setSnapshot(snapshot: Snapshot | null): void;
  setDraining(value: boolean): void;
  /** 传 null 关掉限流闸门（等价于开关关闭）。 */
  setRateLimit(decision: RateLimitDecision | null): void;
  /** 传 null 关掉预算闸门。 */
  setBudget(decision: BudgetDecision | null): void;
  /** 两道闸门各自被调用了几次——用来证「开关关闭时不生效」。 */
  gateCalls: { rateLimit: number; budget: number };
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export async function createHarness(
  opts: { protocol?: 'anthropic' | 'openai' } = {}
): Promise<Harness> {
  const upstream = await startFakeUpstream(jsonResponder(200, '{}'));
  const provider: CatalogProvider = {
    id: 'prov-1',
    name: 'anthropic-prod',
    protocol: opts.protocol ?? 'anthropic',
    baseUrl: upstream.baseUrl,
    credentialId: 'cred-1',
    defaultHeaders: {},
    timeoutMs: 5_000,
  };

  let subject: Subject | null = SUBJECT;
  let snapshot: Snapshot | null = makeSnapshot({ models: [makeModel()], providers: [provider] });
  let draining = false;
  const recorder = new InMemoryCallRecorder();

  // 两道闸门默认**不装配**（= 开关关闭），与 M4 的行为完全一致。
  let rateLimitDecision: RateLimitDecision | null = null;
  let budgetDecision: BudgetDecision | null = null;
  const gateCalls = { rateLimit: 0, budget: 0 };

  const deps: RouterDeps = {
    catalog: {
      get current() {
        return snapshot;
      },
    },
    authenticator: { authenticate: async () => subject },
    recorder,
    get rateLimiter() {
      if (!rateLimitDecision) return undefined;
      return {
        check: async () => {
          gateCalls.rateLimit += 1;
          return rateLimitDecision as RateLimitDecision;
        },
      };
    },
    get budget() {
      if (!budgetDecision) return undefined;
      return {
        check: async () => {
          gateCalls.budget += 1;
          return budgetDecision as BudgetDecision;
        },
      };
    },
    privateKeyPem: KEYPAIR.privateKeyPem,
    isDraining: () => draining,
  };

  const app = createApp(deps);

  return {
    app,
    deps,
    recorder,
    upstream,
    setSubject(next) {
      subject = next;
    },
    setSnapshot(next) {
      snapshot = next;
    },
    setDraining(value) {
      draining = value;
    },
    setRateLimit(decision) {
      rateLimitDecision = decision;
    },
    setBudget(decision) {
      budgetDecision = decision;
    },
    gateCalls,
    fetch: async (path, init) =>
      app.fetch(
        new Request(`http://router.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer rt_caller' },
          ...init,
        })
      ),
    close: () => upstream.close(),
  };
}
