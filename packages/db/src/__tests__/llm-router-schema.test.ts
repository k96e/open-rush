/**
 * llm-router 数据层（0012_llm_router.sql）的 schema 行为测试。
 *
 * 覆盖 M1·T1.1 的验收点：CRUD / FK 级联 / check 约束 / 唯一索引 /
 * `llm_budget_usage` 的 upsert 累加 / `llm_catalog_state` 单行版本位。
 *
 * 设计不变量的守门测试（改表前先看这里为什么这么写）：
 * - `llm_credentials` **没有明文列**——只有 `sealed_value`（specs/llm-router.md §密钥边界）
 * - `llm_router_tokens` 只存 SHA-256，且 `subject_type='run'` 必须带 run_id（D5/D6）
 * - `llm_calls.run_id` 随 run 级联删除；`provider_id` 等归属列刻意无外键（历史事实不随目录变动）
 * - numeric 列经 drizzle 映射成 **string**，不是 number
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestAgent,
  createTestLlmCredential,
  createTestLlmModel,
  createTestLlmProvider,
  createTestProject,
  createTestRun,
  createTestUser,
} from '../../test/factories.js';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../test/pglite-helpers.js';
import {
  llmBudgets,
  llmBudgetUsage,
  llmCalls,
  llmCatalogState,
  llmCredentials,
  llmModels,
  llmProviders,
  llmRouterTokens,
} from '../schema/index.js';

let db: TestDb;
let pglite: PGlite;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function makeRawToken(): string {
  return `rt_${randomBytes(32).toString('base64url')}`;
}

/** 一个必定在未来的过期时间——不要用固定日期，那是定时炸弹。 */
function futureDate(minutes = 30): Date {
  return new Date(Date.now() + minutes * 60_000);
}

async function seedRun(): Promise<{ runId: string; agentId: string; projectId: string }> {
  const user = await createTestUser(db);
  const project = await createTestProject(db, user.id);
  const agent = await createTestAgent(db, project.id, user.id);
  const run = await createTestRun(db, agent.id);
  return { runId: run.id, agentId: agent.id, projectId: project.id };
}

// ---------------------------------------------------------------------------
// llm_credentials
// ---------------------------------------------------------------------------

describe('llm_credentials', () => {
  it('applies defaults (alg / auth_style / version) and stores only the sealed value', async () => {
    const [credential] = await db
      .insert(llmCredentials)
      .values({ name: 'anthropic-prod', keyId: 'f'.repeat(32), sealedValue: 'c2VhbGVk' })
      .returning();

    expect(credential.alg).toBe('x25519-hkdf-sha256-aes256gcm');
    expect(credential.authStyle).toBe('bearer');
    expect(credential.version).toBe(1);
    expect(credential.rotatedAt).toBeNull();
    expect(credential.createdBy).toBeNull();
    expect(credential.sealedValue).toBe('c2VhbGVk');
  });

  it('has no plaintext column — the table can only ever hold sealed material', async () => {
    const result = await pglite.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'llm_credentials'`
    );
    const columns = result.rows.map((r) => r.column_name);

    expect(columns).toContain('sealed_value');
    expect(columns).not.toContain('value');
    expect(columns).not.toContain('plaintext');
    expect(columns).not.toContain('encrypted_value');
  });

  it('rejects a duplicate name', async () => {
    await createTestLlmCredential(db, { name: 'anthropic-prod' });
    await expect(createTestLlmCredential(db, { name: 'anthropic-prod' })).rejects.toThrow();
  });

  it('rotation overwrites the ciphertext in place — no history row survives', async () => {
    const credential = await createTestLlmCredential(db, { name: 'rotate-me' });
    const rotatedAt = new Date();

    const [rotated] = await db
      .update(llmCredentials)
      .set({ sealedValue: 'bmV3LXNlYWxlZA==', version: credential.version + 1, rotatedAt })
      .where(eq(llmCredentials.id, credential.id))
      .returning();

    expect(rotated.version).toBe(2);
    expect(rotated.sealedValue).toBe('bmV3LXNlYWxlZA==');
    expect(rotated.rotatedAt).toBeInstanceOf(Date);

    const rows = await db.select().from(llmCredentials);
    expect(rows).toHaveLength(1);
    expect(rows[0].sealedValue).not.toBe(credential.sealedValue);
  });

  it('nulls created_by when the creating user is deleted (audit row survives)', async () => {
    const user = await createTestUser(db);
    const credential = await createTestLlmCredential(db, { createdBy: user.id });

    await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);

    const [row] = await db
      .select()
      .from(llmCredentials)
      .where(eq(llmCredentials.id, credential.id));
    expect(row).toBeDefined();
    expect(row.createdBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// llm_providers
// ---------------------------------------------------------------------------

describe('llm_providers', () => {
  it('applies defaults (headers / timeout / enabled)', async () => {
    const [provider] = await db
      .insert(llmProviders)
      .values({ name: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' })
      .returning();

    expect(provider.defaultHeaders).toEqual({});
    expect(provider.timeoutMs).toBe(600_000);
    expect(provider.enabled).toBe(true);
    expect(provider.credentialId).toBeNull();
  });

  it('round-trips defaultHeaders as jsonb', async () => {
    const [provider] = await db
      .insert(llmProviders)
      .values({
        name: 'tenant-provider',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com',
        defaultHeaders: { 'X-Tenant': 'rush' },
      })
      .returning();

    expect(provider.defaultHeaders).toEqual({ 'X-Tenant': 'rush' });
  });

  it('rejects a protocol outside the check constraint', async () => {
    await expect(
      db.insert(llmProviders).values({
        name: 'bedrock',
        protocol: 'aws-bedrock',
        baseUrl: 'https://bedrock.example.com',
      })
    ).rejects.toThrow();
  });

  it('refuses to delete a credential that a provider still references (ON DELETE RESTRICT)', async () => {
    const credential = await createTestLlmCredential(db);
    await createTestLlmProvider(db, { credentialId: credential.id });

    await expect(
      db.delete(llmCredentials).where(eq(llmCredentials.id, credential.id))
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// llm_models
// ---------------------------------------------------------------------------

describe('llm_models', () => {
  it('defaults to passthrough shape (alias === upstreamModel) with zero prices as strings', async () => {
    const provider = await createTestLlmProvider(db);
    const model = await createTestLlmModel(db, provider.id, { alias: 'claude-opus-4' });

    expect(model.alias).toBe(model.upstreamModel);
    expect(model.priority).toBe(0);
    expect(model.enabled).toBe(true);
    expect(model.displayName).toBeNull();
    expect(model.maxOutputTokens).toBeNull();
    // numeric → string（不是 number），下游 computeCostUsd 必须按十进制字符串处理
    expect(typeof model.priceInputPerMtok).toBe('string');
    expect(model.priceInputPerMtok).toBe('0.000000');
    expect(model.priceReasoningPerMtok).toBe('0.000000');
  });

  it('keeps decimal prices exact through the numeric column', async () => {
    const provider = await createTestLlmProvider(db);
    const model = await createTestLlmModel(db, provider.id, {
      alias: 'claude-sonnet-4',
      priceInputPerMtok: '3.000000',
      priceOutputPerMtok: '15.000000',
    });

    expect(model.priceInputPerMtok).toBe('3.000000');
    expect(model.priceOutputPerMtok).toBe('15.000000');
  });

  it('enforces llm_models_alias_provider_idx — one alias per provider', async () => {
    const provider = await createTestLlmProvider(db);
    await createTestLlmModel(db, provider.id, { alias: 'claude-opus-4' });

    await expect(createTestLlmModel(db, provider.id, { alias: 'claude-opus-4' })).rejects.toThrow();
  });

  it('allows the same alias on two providers (that is the fallback-chain shape)', async () => {
    const primary = await createTestLlmProvider(db, { name: 'primary' });
    const secondary = await createTestLlmProvider(db, { name: 'secondary' });

    await createTestLlmModel(db, primary.id, { alias: 'claude-opus-4', priority: 0 });
    await createTestLlmModel(db, secondary.id, { alias: 'claude-opus-4', priority: 10 });

    const rows = await db.select().from(llmModels).where(eq(llmModels.alias, 'claude-opus-4'));
    expect(rows).toHaveLength(2);
  });

  it('cascades model deletion when its provider is deleted', async () => {
    const provider = await createTestLlmProvider(db);
    await createTestLlmModel(db, provider.id);

    await db.delete(llmProviders).where(eq(llmProviders.id, provider.id));

    expect(await db.select().from(llmModels)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// llm_router_tokens
// ---------------------------------------------------------------------------

describe('llm_router_tokens', () => {
  it('stores only the SHA-256 of the plaintext token', async () => {
    const { runId, agentId, projectId } = await seedRun();
    const raw = makeRawToken();

    const [token] = await db
      .insert(llmRouterTokens)
      .values({
        tokenHash: hashToken(raw),
        subjectType: 'run',
        runId,
        agentId,
        projectId,
        expiresAt: futureDate(),
      })
      .returning();

    expect(token.tokenHash).toBe(hashToken(raw));
    expect(token.tokenHash).not.toContain(raw);
    expect(token.allowedModelAliases).toEqual([]);
    expect(token.maxCostUsd).toBeNull();
    expect(token.maxRequestsPerMinute).toBeNull();
    expect(token.revokedAt).toBeNull();
    expect(token.lastUsedAt).toBeNull();
  });

  it('rejects a duplicate token hash', async () => {
    const { runId } = await seedRun();
    const tokenHash = hashToken(makeRawToken());

    await db
      .insert(llmRouterTokens)
      .values({ tokenHash, subjectType: 'run', runId, expiresAt: futureDate() });

    await expect(
      db
        .insert(llmRouterTokens)
        .values({ tokenHash, subjectType: 'run', runId, expiresAt: futureDate() })
    ).rejects.toThrow();
  });

  it('rejects subject_type="run" without a run_id (llm_router_tokens_subject_check)', async () => {
    await expect(
      db.insert(llmRouterTokens).values({
        tokenHash: hashToken(makeRawToken()),
        subjectType: 'run',
        expiresAt: futureDate(),
      })
    ).rejects.toThrow();
  });

  it('allows subject_type="service" without a run_id', async () => {
    const [token] = await db
      .insert(llmRouterTokens)
      .values({
        tokenHash: hashToken(makeRawToken()),
        subjectType: 'service',
        expiresAt: futureDate(60 * 24),
      })
      .returning();

    expect(token.subjectType).toBe('service');
    expect(token.runId).toBeNull();
  });

  it('persists an allowlist of aliases and per-token quotas', async () => {
    const { runId } = await seedRun();
    const [token] = await db
      .insert(llmRouterTokens)
      .values({
        tokenHash: hashToken(makeRawToken()),
        subjectType: 'run',
        runId,
        allowedModelAliases: ['claude-opus-4', 'claude-sonnet-4'],
        maxCostUsd: '1.500000',
        maxRequestsPerMinute: 60,
        expiresAt: futureDate(),
      })
      .returning();

    expect(token.allowedModelAliases).toEqual(['claude-opus-4', 'claude-sonnet-4']);
    expect(token.maxCostUsd).toBe('1.500000');
    expect(token.maxRequestsPerMinute).toBe(60);
  });

  it('cascades token deletion when the run is deleted', async () => {
    const { runId } = await seedRun();
    await db.insert(llmRouterTokens).values({
      tokenHash: hashToken(makeRawToken()),
      subjectType: 'run',
      runId,
      expiresAt: futureDate(),
    });

    await db.execute(sql`DELETE FROM runs WHERE id = ${runId}`);

    expect(await db.select().from(llmRouterTokens)).toHaveLength(0);
  });

  it('supports the active-token predicate the authenticator will use', async () => {
    const { runId } = await seedRun();
    const liveHash = hashToken(makeRawToken());
    const revokedHash = hashToken(makeRawToken());

    await db.insert(llmRouterTokens).values([
      { tokenHash: liveHash, subjectType: 'run', runId, expiresAt: futureDate() },
      {
        tokenHash: revokedHash,
        subjectType: 'run',
        runId,
        expiresAt: futureDate(),
        revokedAt: new Date(),
      },
    ]);

    const active = await db
      .select()
      .from(llmRouterTokens)
      .where(and(isNull(llmRouterTokens.revokedAt), eq(llmRouterTokens.runId, runId)));

    expect(active).toHaveLength(1);
    expect(active[0].tokenHash).toBe(liveHash);
  });
});

// ---------------------------------------------------------------------------
// llm_calls
// ---------------------------------------------------------------------------

describe('llm_calls', () => {
  async function insertCall(overrides: Partial<typeof llmCalls.$inferInsert> = {}) {
    const [call] = await db
      .insert(llmCalls)
      .values({
        subjectType: 'run',
        modelAlias: 'claude-opus-4',
        protocol: 'anthropic',
        mode: 'passthrough',
        status: 'success',
        startedAt: new Date(),
        ...overrides,
      })
      .returning();
    return call;
  }

  it('defaults every token counter and cost to zero', async () => {
    const call = await insertCall();

    expect(call.tokensIn).toBe(0);
    expect(call.tokensCacheWrite).toBe(0);
    expect(call.tokensCacheRead).toBe(0);
    expect(call.tokensOut).toBe(0);
    expect(call.tokensReasoning).toBe(0);
    expect(call.costUsd).toBe('0.000000');
    expect(call.stream).toBe(false);
    expect(call.completedAt).toBeNull();
  });

  it('keeps the four token classes separable (A5)', async () => {
    const call = await insertCall({
      tokensIn: 1200,
      tokensCacheWrite: 300,
      tokensCacheRead: 4500,
      tokensOut: 800,
      tokensReasoning: 0,
      costUsd: '0.012345',
      ttfbMs: 180,
      latencyMs: 4200,
      completedAt: new Date(),
    });

    expect(call.tokensIn).toBe(1200);
    expect(call.tokensCacheWrite).toBe(300);
    expect(call.tokensCacheRead).toBe(4500);
    expect(call.tokensOut).toBe(800);
    expect(call.costUsd).toBe('0.012345');
    expect(call.ttfbMs).toBe(180);
    expect(call.latencyMs).toBe(4200);
  });

  it('records cc_* header hints without letting them become attribution', async () => {
    const { runId, agentId, projectId } = await seedRun();
    const call = await insertCall({
      runId,
      agentId,
      projectId,
      ccSessionId: 'sess-from-header',
      ccAgentId: 'agent-from-header',
    });

    // 归属来自令牌（run/agent/project），cc_* 只是分组提示（D6）
    expect(call.runId).toBe(runId);
    expect(call.agentId).toBe(agentId);
    expect(call.projectId).toBe(projectId);
    expect(call.ccSessionId).toBe('sess-from-header');
    expect(call.ccAgentId).toBe('agent-from-header');
  });

  it('cascades call rows when the run is deleted', async () => {
    const { runId } = await seedRun();
    await insertCall({ runId });

    await db.execute(sql`DELETE FROM runs WHERE id = ${runId}`);

    expect(await db.select().from(llmCalls)).toHaveLength(0);
  });

  it('nulls token_id when the token is revoked-and-deleted but keeps the metering row', async () => {
    const { runId } = await seedRun();
    const [token] = await db
      .insert(llmRouterTokens)
      .values({
        tokenHash: hashToken(makeRawToken()),
        subjectType: 'run',
        runId,
        expiresAt: futureDate(),
      })
      .returning();
    const call = await insertCall({ tokenId: token.id });

    await db.delete(llmRouterTokens).where(eq(llmRouterTokens.id, token.id));

    const [row] = await db.select().from(llmCalls).where(eq(llmCalls.id, call.id));
    expect(row).toBeDefined();
    expect(row.tokenId).toBeNull();
  });

  it('keeps provider_id after the provider is deleted (no FK — metering is history)', async () => {
    const provider = await createTestLlmProvider(db);
    const call = await insertCall({ providerId: provider.id, upstreamModel: 'claude-opus-4' });

    await db.delete(llmProviders).where(eq(llmProviders.id, provider.id));

    const [row] = await db.select().from(llmCalls).where(eq(llmCalls.id, call.id));
    expect(row.providerId).toBe(provider.id);
    expect(row.upstreamModel).toBe('claude-opus-4');
  });

  it('records failure terminal states with their http status and error code', async () => {
    const call = await insertCall({
      status: 'upstream_error',
      httpStatus: 502,
      errorCode: 'upstream_unavailable',
    });

    expect(call.status).toBe('upstream_error');
    expect(call.httpStatus).toBe(502);
    expect(call.errorCode).toBe('upstream_unavailable');
  });
});

// ---------------------------------------------------------------------------
// llm_budgets / llm_budget_usage
// ---------------------------------------------------------------------------

describe('llm_budgets', () => {
  it('defaults to the observe tier (enforce = false)', async () => {
    const [budget] = await db
      .insert(llmBudgets)
      .values({ subjectType: 'global', subjectId: null, window: 'day', limitUsd: '100.000000' })
      .returning();

    expect(budget.enforce).toBe(false);
    expect(budget.subjectId).toBeNull();
    expect(budget.limitUsd).toBe('100.000000');
  });

  it('rejects a second global/day budget — NULL subject_id still collides', async () => {
    await db
      .insert(llmBudgets)
      .values({ subjectType: 'global', subjectId: null, window: 'day', limitUsd: '100.000000' });

    await expect(
      db
        .insert(llmBudgets)
        .values({ subjectType: 'global', subjectId: null, window: 'day', limitUsd: '250.000000' })
    ).rejects.toThrow();
  });

  it('keeps windows independent for the same subject', async () => {
    const subjectId = randomUUID();
    await db.insert(llmBudgets).values([
      { subjectType: 'project', subjectId, window: 'day', limitUsd: '10.000000' },
      { subjectType: 'project', subjectId, window: 'month', limitUsd: '200.000000' },
    ]);

    const rows = await db.select().from(llmBudgets).where(eq(llmBudgets.subjectId, subjectId));
    expect(rows).toHaveLength(2);
  });
});

describe('llm_budget_usage', () => {
  /** M5 的 CallRecorder 会用同一条语句累加——测试直接跑它，避免测到一个假的形状。 */
  async function accumulate(
    subjectType: string,
    subjectId: string | null,
    windowKey: string,
    costUsd: string,
    tokens: number
  ) {
    await db
      .insert(llmBudgetUsage)
      .values({ subjectType, subjectId, windowKey, costUsd, tokens, calls: 1 })
      .onConflictDoUpdate({
        target: [llmBudgetUsage.subjectType, llmBudgetUsage.subjectId, llmBudgetUsage.windowKey],
        set: {
          costUsd: sql`${llmBudgetUsage.costUsd} + excluded.cost_usd`,
          tokens: sql`${llmBudgetUsage.tokens} + excluded.tokens`,
          calls: sql`${llmBudgetUsage.calls} + excluded.calls`,
          updatedAt: new Date(),
        },
      });
  }

  it('accumulates on the composite key instead of inserting a second row', async () => {
    const projectId = randomUUID();
    await accumulate('project', projectId, '2026-09-08', '0.010000', 100);
    await accumulate('project', projectId, '2026-09-08', '0.025000', 250);

    const rows = await db.select().from(llmBudgetUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBe('0.035000');
    expect(rows[0].tokens).toBe(350);
    expect(rows[0].calls).toBe(2);
  });

  it('accumulates the global row too, where subject_id is NULL', async () => {
    await accumulate('global', null, '2026-09-08', '0.100000', 1000);
    await accumulate('global', null, '2026-09-08', '0.200000', 2000);

    const rows = await db.select().from(llmBudgetUsage).where(isNull(llmBudgetUsage.subjectId));
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBe('0.300000');
    expect(rows[0].tokens).toBe(3000);
    expect(rows[0].calls).toBe(2);
  });

  it('keeps separate rows per window key and per subject', async () => {
    const projectId = randomUUID();
    await accumulate('project', projectId, '2026-09-08', '0.010000', 100);
    await accumulate('project', projectId, '2026-09', '0.010000', 100);
    await accumulate('project', randomUUID(), '2026-09-08', '0.010000', 100);
    await accumulate('global', null, 'total', '0.010000', 100);

    expect(await db.select().from(llmBudgetUsage)).toHaveLength(4);
  });

  it('defaults cost/tokens/calls to zero on a bare insert', async () => {
    const [row] = await db
      .insert(llmBudgetUsage)
      .values({ subjectType: 'user', subjectId: randomUUID(), windowKey: 'total' })
      .returning();

    expect(row.costUsd).toBe('0.000000');
    expect(row.tokens).toBe(0);
    expect(row.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// llm_catalog_state
// ---------------------------------------------------------------------------

describe('llm_catalog_state', () => {
  it('is seeded with exactly one row at version 0', async () => {
    const rows = await db.select().from(llmCatalogState);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].version).toBe(0);
  });

  it('bumps monotonically — this is what NOTIFY and the poll fallback both read', async () => {
    const bump = async () => {
      const [row] = await db
        .update(llmCatalogState)
        .set({ version: sql`${llmCatalogState.version} + 1`, updatedAt: new Date() })
        .where(eq(llmCatalogState.id, 1))
        .returning({ version: llmCatalogState.version });
      return row.version;
    };

    expect(await bump()).toBe(1);
    expect(await bump()).toBe(2);
    expect(await db.select().from(llmCatalogState)).toHaveLength(1);
  });

  it('refuses a second row — the version bit is single-row by construction', async () => {
    await expect(db.insert(llmCatalogState).values({ id: 1, version: 99 })).rejects.toThrow();
  });
});
