/**
 * DrizzleTokenStore 单测（M4·T4.2）。
 *
 * 真库上才说得清的三条：未吊销、未过期（用 **DB 时间** 判定）、哈希唯一。
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmRouterTokens } from '@open-rush/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import { DrizzleTokenStore } from '../drizzle-token-store.js';
import { hashRouterToken, mintRouterToken } from '../router-token.js';

let db: TestDb;
let pglite: PGlite;
let store: DrizzleTokenStore;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
  store = new DrizzleTokenStore(db as never);
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

async function insertToken(
  values: Partial<typeof llmRouterTokens.$inferInsert> = {}
): Promise<{ id: string; plaintext: string }> {
  const { plaintext, tokenHash } = mintRouterToken();
  const [row] = await db
    .insert(llmRouterTokens)
    .values({
      tokenHash,
      subjectType: 'service',
      expiresAt: inHours(1),
      ...values,
    })
    .returning();
  return { id: row.id, plaintext };
}

describe('DrizzleTokenStore.findActiveByHash', () => {
  it('可用令牌 → 完整归属', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const agentId = '22222222-2222-4222-8222-222222222222';
    const projectId = '33333333-3333-4333-8333-333333333333';
    const ownerUserId = '44444444-4444-4444-8444-444444444444';
    const { id, plaintext } = await insertToken({
      subjectType: 'run',
      runId,
      agentId,
      projectId,
      ownerUserId,
      allowedModelAliases: ['sonnet', 'haiku'],
      maxCostUsd: '12.500000',
      maxRequestsPerMinute: 60,
    });

    await expect(store.findActiveByHash(hashRouterToken(plaintext))).resolves.toEqual({
      tokenId: id,
      subjectType: 'run',
      runId,
      agentId,
      projectId,
      ownerUserId,
      allowedModelAliases: ['sonnet', 'haiku'],
      maxCostUsd: '12.500000',
      maxRequestsPerMinute: 60,
    });
  });

  it('service 令牌的 run/agent/project 允许全空', async () => {
    const { plaintext } = await insertToken({ subjectType: 'service' });
    await expect(store.findActiveByHash(hashRouterToken(plaintext))).resolves.toMatchObject({
      subjectType: 'service',
      runId: null,
      projectId: null,
      allowedModelAliases: [],
      maxCostUsd: null,
      maxRequestsPerMinute: null,
    });
  });

  it('已吊销 → null', async () => {
    const { plaintext } = await insertToken({ revokedAt: new Date() });
    await expect(store.findActiveByHash(hashRouterToken(plaintext))).resolves.toBeNull();
  });

  it('已过期 → null', async () => {
    const { plaintext } = await insertToken({ expiresAt: inHours(-1) });
    await expect(store.findActiveByHash(hashRouterToken(plaintext))).resolves.toBeNull();
  });

  it('未知哈希 → null', async () => {
    await expect(store.findActiveByHash(hashRouterToken('rt_never-issued'))).resolves.toBeNull();
  });

  it('哈希唯一：同一个 token_hash 不能插两行', async () => {
    const { plaintext } = await insertToken();
    await expect(
      db.insert(llmRouterTokens).values({
        tokenHash: hashRouterToken(plaintext),
        subjectType: 'service',
        expiresAt: inHours(1),
      })
    ).rejects.toThrow();
  });

  it('subject_type 的 CHECK 生效：run 必须带 run_id', async () => {
    await expect(
      db.insert(llmRouterTokens).values({
        tokenHash: hashRouterToken('rt_no-run'),
        subjectType: 'run',
        expiresAt: inHours(1),
      })
    ).rejects.toThrow();
  });
});

describe('DrizzleTokenStore.touchLastUsed', () => {
  it('写入 last_used_at', async () => {
    const { id, plaintext } = await insertToken();
    const before = await db.select().from(llmRouterTokens).where(eq(llmRouterTokens.id, id));
    expect(before[0].lastUsedAt).toBeNull();

    await store.touchLastUsed(id);

    const after = await db.select().from(llmRouterTokens).where(eq(llmRouterTokens.id, id));
    expect(after[0].lastUsedAt).toBeInstanceOf(Date);
    // 不改动令牌的其他任何字段
    expect(after[0].tokenHash).toBe(hashRouterToken(plaintext));
    expect(after[0].revokedAt).toBeNull();
  });

  it('不存在的 id → 静默无操作', async () => {
    await expect(
      store.touchLastUsed('55555555-5555-4555-8555-555555555555')
    ).resolves.toBeUndefined();
  });
});
