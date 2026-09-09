/**
 * RunOrchestrator × llm-router 接线（M6·T6.2）。
 *
 * 四条硬约束，一条一组用例：
 *  ① `sendPrompt` 收到 `modelId`（`ref/R1` §2.6 的断链，Red Test 先行）；
 *  ② 装配 llmAccess 时沙箱 env 有网关三件套，且**两条路径都要有**
 *     （`sandboxProvider.create` 与 `agentBridge.sendPrompt`，见 `ref/R3` §4.2.1）；
 *  ③ `finally` 里必定 revoke——成功路径与抛错路径各一例；
 *  ④ 未装配 llmAccess 时行为与改造前零差异。
 */
import type { CreateSandboxOptions, SandboxInfo, SandboxProvider } from '@open-rush/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventStore } from '../event-store.js';
import type { LlmAccessService, LlmGrant } from '../llm/llm-access-service.js';
import type { RunUsageTotals } from '../llm/router-token-store.js';
import { AgentExecutor } from '../run/agent-executor.js';
import { RunOrchestrator } from '../run/run-orchestrator.js';
import type { CreateRunInput, Run, RunDb } from '../run/run-service.js';
import { RunService } from '../run/run-service.js';
import type { RunStatus } from '../run/run-state-machine.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockRunDb implements RunDb {
  private runs = new Map<string, Run>();
  async create(_input: CreateRunInput): Promise<Run> {
    throw new Error('unused');
  }
  async findById(id: string): Promise<Run | null> {
    const run = this.runs.get(id);
    return run ? { ...run } : null;
  }
  async updateStatus(id: string, status: RunStatus, extra?: Partial<Run>): Promise<Run | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    run.status = status;
    if (extra) Object.assign(run, extra);
    return { ...run };
  }
  async listByAgent(): Promise<Run[]> {
    return [];
  }
  async findStuckRuns(): Promise<Run[]> {
    return [];
  }
  seed(run: Run): void {
    this.runs.set(run.id, { ...run });
  }
}

class MockSandboxProvider implements SandboxProvider {
  createCalls: CreateSandboxOptions[] = [];
  async create(opts: CreateSandboxOptions): Promise<SandboxInfo> {
    this.createCalls.push(opts);
    return {
      id: 'sbx-1',
      status: 'running',
      endpoint: 'http://localhost:8787',
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
  async getEndpointUrl(_id: string, port: number): Promise<string | null> {
    return `http://localhost:${port}`;
  }
  async exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

/** 记录调用、可控返回的假 LlmAccessService（只实现被用到的三个方法）。 */
class FakeLlmAccess {
  issueCalls: Array<Record<string, unknown>> = [];
  revokeCalls: string[] = [];
  usage: RunUsageTotals | null = null;
  grant: LlmGrant = {
    tokenId: 'tok-1',
    env: {
      ANTHROPIC_BASE_URL: 'http://router:8790',
      ANTHROPIC_AUTH_TOKEN: 'rt_fake-plaintext',
      ANTHROPIC_MODEL: 'glm-4.7',
    },
  };
  issueError: Error | null = null;
  revokeError: Error | null = null;

  async issueForRun(ctx: Record<string, unknown>): Promise<LlmGrant> {
    this.issueCalls.push(ctx);
    if (this.issueError) throw this.issueError;
    return this.grant;
  }
  async revokeForRun(runId: string): Promise<number> {
    this.revokeCalls.push(runId);
    if (this.revokeError) throw this.revokeError;
    return 1;
  }
  async aggregateUsage(_runId: string): Promise<RunUsageTotals | null> {
    return this.usage;
  }

  asService(): LlmAccessService {
    return this as unknown as LlmAccessService;
  }
}

function makeQueuedRun(id: string): Run {
  return {
    id,
    agentId: 'agent-1',
    taskId: null,
    conversationId: null,
    parentRunId: null,
    status: 'queued',
    prompt: 'test prompt',
    provider: 'anthropic',
    connectionMode: 'sse',
    modelId: null,
    triggerSource: 'api',
    agentDefinitionVersion: 3,
    idempotencyKey: null,
    idempotencyRequestHash: null,
    activeStreamId: null,
    retryCount: 0,
    maxRetries: 3,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
  };
}

function sseResponse(): Response {
  return new Response('data: {"type":"text_delta","content":"hi"}\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 返回最近一次 `POST /prompt` 的请求体。 */
function lastPromptBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  const init = call?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

function makeExecutor(model: string | null, env: Record<string, string> = {}): AgentExecutor {
  return new AgentExecutor({
    resolveAgent: async () => ({
      id: 'agent-1',
      projectId: 'proj-1',
      name: 'web-builder',
      model,
      scope: 'project',
      status: 'active',
      systemPrompt: null,
      createdBy: 'user-1',
      allowedTools: ['Bash'],
      maxSteps: 30,
    }),
    resolveVaultEnv: async () => env,
    resolveSkills: async () => [],
    resolveMcpServers: async () => [],
  });
}

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;
let runDb: MockRunDb;
let runService: RunService;
let sandboxProvider: MockSandboxProvider;
let eventStore: InMemoryEventStore;
let llmAccess: FakeLlmAccess;

beforeEach(() => {
  fetchMock = vi.fn(async () => sseResponse());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  runDb = new MockRunDb();
  runService = new RunService(runDb);
  sandboxProvider = new MockSandboxProvider();
  eventStore = new InMemoryEventStore();
  llmAccess = new FakeLlmAccess();
  runDb.seed(makeQueuedRun('run-1'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENRUSH_V1_EVENTS_ENABLED;
  vi.restoreAllMocks();
});

function makeOrchestrator(opts: {
  withLlmAccess: boolean;
  model?: string | null;
  vaultEnv?: Record<string, string>;
}): RunOrchestrator {
  return new RunOrchestrator({
    runService,
    sandboxProvider,
    eventStore,
    agentExecutor: makeExecutor(opts.model ?? null, opts.vaultEnv),
    resolveProjectIdForAgent: async () => 'proj-1',
    ...(opts.withLlmAccess ? { llmAccess: llmAccess.asService() } : {}),
  });
}

// ---------------------------------------------------------------------------
// ① modelId 断链（Red Test 先行）
// ---------------------------------------------------------------------------

describe('modelId 断链（R1 §2.6）', () => {
  it('sendPrompt 收到 agents.model 解析出的 alias', async () => {
    await makeOrchestrator({ withLlmAccess: false, model: 'glm-4.7' }).execute(
      'run-1',
      'p',
      'agent-1'
    );
    expect(lastPromptBody(fetchMock).modelId).toBe('glm-4.7');
  });

  it('agents.model 为空时传全局缺省，而不是 undefined', async () => {
    await makeOrchestrator({ withLlmAccess: false, model: null }).execute('run-1', 'p', 'agent-1');
    expect(lastPromptBody(fetchMock).modelId).toBe('sonnet');
  });

  it('没有 agentExecutor 时仍然不传 modelId（agent-worker 自己兜底）', async () => {
    const orchestrator = new RunOrchestrator({ runService, sandboxProvider, eventStore });
    await orchestrator.execute('run-1', 'p', 'agent-1');
    expect(lastPromptBody(fetchMock).modelId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ② 装配 llmAccess：签发 + 两条注入路径
// ---------------------------------------------------------------------------

describe('装配 llmAccess', () => {
  it('签发发生在 sandbox 创建之前（否则 env 注不进去）', async () => {
    const order: string[] = [];
    llmAccess.issueForRun = async (ctx) => {
      order.push('issue');
      llmAccess.issueCalls.push(ctx);
      return llmAccess.grant;
    };
    const origCreate = sandboxProvider.create.bind(sandboxProvider);
    sandboxProvider.create = async (opts) => {
      order.push('create');
      return origCreate(opts);
    };

    await makeOrchestrator({ withLlmAccess: true, model: 'glm-4.7' }).execute(
      'run-1',
      'p',
      'agent-1'
    );
    expect(order).toEqual(['issue', 'create']);
  });

  it('签发入参带齐归属与 alias', async () => {
    await makeOrchestrator({ withLlmAccess: true, model: 'glm-4.7' }).execute(
      'run-1',
      'p',
      'agent-1'
    );
    expect(llmAccess.issueCalls[0]).toMatchObject({
      runId: 'run-1',
      agentId: 'agent-1',
      projectId: 'proj-1',
      ownerUserId: 'user-1',
      modelAlias: 'glm-4.7',
    });
  });

  it('沙箱 env 里有网关三件套', async () => {
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');
    expect(sandboxProvider.createCalls[0].env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://router:8790',
      ANTHROPIC_AUTH_TOKEN: 'rt_fake-plaintext',
      ANTHROPIC_MODEL: 'glm-4.7',
    });
  });

  it('⚠️ sendPrompt 也要拿到同一份 env——dev 下 LocalDevSandboxProvider 忽略 options（R3 §4.2.1）', async () => {
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');
    expect(lastPromptBody(fetchMock).env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://router:8790',
      ANTHROPIC_AUTH_TOKEN: 'rt_fake-plaintext',
    });
    // 两条路径必须是同一份，不能一条有一条没有。
    expect(lastPromptBody(fetchMock).env).toEqual(sandboxProvider.createCalls[0].env);
  });

  it('合并顺序固定：router 后写，盖掉 Vault 里同名的键', async () => {
    const orchestrator = makeOrchestrator({
      withLlmAccess: true,
      vaultEnv: {
        FOO: 'from-vault',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'vault-token',
      },
    });
    await orchestrator.execute('run-1', 'p', 'agent-1');

    const env = sandboxProvider.createCalls[0].env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe('http://router:8790');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('rt_fake-plaintext');
    // Vault 里其余的键照常透传。
    expect(env.FOO).toBe('from-vault');
  });

  it('签发失败 → run 转 failed，且仍然走 revoke（finally）', async () => {
    llmAccess.issueError = new Error('token store down');
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');

    expect((await runService.getById('run-1'))?.status).toBe('failed');
    expect(llmAccess.revokeCalls).toEqual(['run-1']);
    expect(sandboxProvider.createCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ③ finally 必定 revoke
// ---------------------------------------------------------------------------

describe('令牌吊销', () => {
  it('成功路径也吊销', async () => {
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');
    expect((await runService.getById('run-1'))?.status).toBe('completed');
    expect(llmAccess.revokeCalls).toEqual(['run-1']);
  });

  it('抛错路径也吊销', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('agent worker unreachable');
    });
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');
    expect((await runService.getById('run-1'))?.status).toBe('failed');
    expect(llmAccess.revokeCalls).toEqual(['run-1']);
  });

  it('吊销本身失败不掩盖 run 的结果（只记一条 error 日志）', async () => {
    llmAccess.revokeError = new Error('db down');
    await expect(
      makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1')
    ).resolves.toBeUndefined();
    expect((await runService.getById('run-1'))?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// data-openrush-usage 回写
// ---------------------------------------------------------------------------

describe('data-openrush-usage', () => {
  it('v1 flag 开 + 有用量 → 在 run-done 之前发出', async () => {
    process.env.OPENRUSH_V1_EVENTS_ENABLED = 'true';
    llmAccess.usage = { tokensIn: 120, tokensOut: 30, costUsd: 0.0042 };

    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');

    const types = (await eventStore.getEvents('run-1')).map((e) => e.eventType);
    const usageIdx = types.indexOf('data-openrush-usage');
    const doneIdx = types.indexOf('data-openrush-run-done');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    // 终态标记之前——停在 run-done 上的消费者不该漏掉用量。
    expect(usageIdx).toBeLessThan(doneIdx);

    const event = (await eventStore.getEvents('run-1'))[usageIdx];
    expect(event.payload).toEqual({
      type: 'data-openrush-usage',
      data: { tokensIn: 120, tokensOut: 30, costUsd: 0.0042 },
    });
  });

  it('没有用量记录 → 不发事件', async () => {
    process.env.OPENRUSH_V1_EVENTS_ENABLED = 'true';
    llmAccess.usage = null;
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');
    const types = (await eventStore.getEvents('run-1')).map((e) => e.eventType);
    expect(types).not.toContain('data-openrush-usage');
  });

  it('v1 flag 关 → 不发事件（既有协议不变）', async () => {
    llmAccess.usage = { tokensIn: 1, tokensOut: 1, costUsd: 1 };
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');
    const types = (await eventStore.getEvents('run-1')).map((e) => e.eventType);
    expect(types).not.toContain('data-openrush-usage');
  });

  it('聚合抛错不影响 run 收敛（A5：计量失败不阻塞）', async () => {
    process.env.OPENRUSH_V1_EVENTS_ENABLED = 'true';
    llmAccess.aggregateUsage = async () => {
      throw new Error('aggregate failed');
    };
    await makeOrchestrator({ withLlmAccess: true }).execute('run-1', 'p', 'agent-1');
    expect((await runService.getById('run-1'))?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// ④ 未装配 llmAccess = 零变化（灰度 / 回滚开关）
// ---------------------------------------------------------------------------

describe('未装配 llmAccess（回归）', () => {
  it('不签发、不吊销、不发 usage', async () => {
    process.env.OPENRUSH_V1_EVENTS_ENABLED = 'true';
    await makeOrchestrator({ withLlmAccess: false }).execute('run-1', 'p', 'agent-1');

    expect(llmAccess.issueCalls).toHaveLength(0);
    expect(llmAccess.revokeCalls).toHaveLength(0);
    const types = (await eventStore.getEvents('run-1')).map((e) => e.eventType);
    expect(types).not.toContain('data-openrush-usage');
  });

  it('沙箱 env 逐字等于 Vault env——一个 ANTHROPIC_* 都不多', async () => {
    await makeOrchestrator({
      withLlmAccess: false,
      vaultEnv: { FOO: 'bar' },
    }).execute('run-1', 'p', 'agent-1');

    expect(sandboxProvider.createCalls[0].env).toEqual({ FOO: 'bar' });
    expect(lastPromptBody(fetchMock).env).toEqual({ FOO: 'bar' });
  });

  it('没有 agentExecutor 时 env 仍是 undefined（不是 {}）', async () => {
    const orchestrator = new RunOrchestrator({ runService, sandboxProvider, eventStore });
    await orchestrator.execute('run-1', 'p', 'agent-1');
    expect(sandboxProvider.createCalls[0].env).toBeUndefined();
    expect(lastPromptBody(fetchMock).env).toBeUndefined();
  });

  it('run 照常走到 completed', async () => {
    await makeOrchestrator({ withLlmAccess: false }).execute('run-1', 'p', 'agent-1');
    expect((await runService.getById('run-1'))?.status).toBe('completed');
  });
});
