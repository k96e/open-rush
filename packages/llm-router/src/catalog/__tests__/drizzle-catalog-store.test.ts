/**
 * DrizzleCatalogStore 单测（M3·T3.1）。
 *
 * 守住 A4 的四条加载不变量：
 *  - 只加载 enabled 的 model
 *  - provider 停用时它名下的 model 全部从索引里消失
 *  - 同 alias 按 priority 升序
 *  - priority 并列时按 model.id 升序（确定性，A4 的判定依据）
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmCatalogState, llmCredentials, llmModels, llmProviders } from '@open-rush/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import { CatalogStateMissingError } from '../bump-version.js';
import { DrizzleCatalogStore } from '../drizzle-catalog-store.js';

let db: TestDb;
let pglite: PGlite;
let store: DrizzleCatalogStore;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
  store = new DrizzleCatalogStore(db as never);
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

async function insertCredential(name = 'anthropic-prod') {
  const [row] = await db
    .insert(llmCredentials)
    .values({ name, keyId: 'a'.repeat(32), sealedValue: 'SEALED-BASE64' })
    .returning();
  return row;
}

async function insertProvider(
  overrides: Partial<typeof llmProviders.$inferInsert> = {}
): Promise<typeof llmProviders.$inferSelect> {
  const [row] = await db
    .insert(llmProviders)
    .values({
      name: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      ...overrides,
    })
    .returning();
  return row;
}

async function insertModel(
  providerId: string,
  overrides: Partial<typeof llmModels.$inferInsert> = {}
): Promise<typeof llmModels.$inferSelect> {
  const [row] = await db
    .insert(llmModels)
    .values({
      alias: 'claude-opus-5',
      providerId,
      upstreamModel: 'claude-opus-5',
      ...overrides,
    })
    .returning();
  return row;
}

describe('DrizzleCatalogStore.readVersion', () => {
  it('reads the singleton version row', async () => {
    expect(await store.readVersion()).toBe(0);
    await db.update(llmCatalogState).set({ version: 7 }).where(eq(llmCatalogState.id, 1));
    expect(await store.readVersion()).toBe(7);
  });

  it('throws CatalogStateMissingError when the seed row is gone', async () => {
    await db.delete(llmCatalogState).where(eq(llmCatalogState.id, 1));
    await expect(store.readVersion()).rejects.toBeInstanceOf(CatalogStateMissingError);
  });
});

describe('DrizzleCatalogStore.loadSnapshot', () => {
  it('indexes enabled models by alias and carries the version through', async () => {
    const credential = await insertCredential();
    const provider = await insertProvider({ credentialId: credential.id });
    await insertModel(provider.id);

    const snapshot = await store.loadSnapshot(42);

    expect(snapshot.version).toBe(42);
    expect(snapshot.byAlias.get('claude-opus-5')).toHaveLength(1);
    expect(snapshot.providers.get(provider.id)?.name).toBe('anthropic');
    expect(snapshot.credentials.get(credential.id)?.sealedValue).toBe('SEALED-BASE64');
  });

  it('skips disabled models', async () => {
    const provider = await insertProvider();
    await insertModel(provider.id, { alias: 'off', upstreamModel: 'off', enabled: false });
    await insertModel(provider.id, { alias: 'on', upstreamModel: 'on' });

    const snapshot = await store.loadSnapshot(1);
    expect(snapshot.byAlias.has('off')).toBe(false);
    expect(snapshot.byAlias.has('on')).toBe(true);
  });

  it('drops every model of a disabled provider', async () => {
    const provider = await insertProvider({ enabled: false });
    await insertModel(provider.id);

    const snapshot = await store.loadSnapshot(1);
    expect(snapshot.byAlias.size).toBe(0);
    expect(snapshot.providers.size).toBe(0);
  });

  it('orders same-alias candidates by priority ascending', async () => {
    const cheap = await insertProvider({ name: 'cheap' });
    const dear = await insertProvider({ name: 'dear' });
    await insertModel(dear.id, { priority: 10 });
    await insertModel(cheap.id, { priority: 1 });

    const snapshot = await store.loadSnapshot(1);
    const candidates = snapshot.byAlias.get('claude-opus-5') ?? [];
    expect(candidates.map((m) => m.priority)).toEqual([1, 10]);
    expect(candidates[0].providerId).toBe(cheap.id);
  });

  it('breaks priority ties by model id ascending (deterministic, A4)', async () => {
    const a = await insertProvider({ name: 'a' });
    const b = await insertProvider({ name: 'b' });
    const first = await insertModel(a.id, { priority: 0 });
    const second = await insertModel(b.id, { priority: 0 });

    const snapshot = await store.loadSnapshot(1);
    const ids = (snapshot.byAlias.get('claude-opus-5') ?? []).map((m) => m.id);
    expect(ids).toEqual([first.id, second.id].sort());
  });

  it('only loads credentials referenced by enabled providers', async () => {
    const used = await insertCredential('used');
    const orphan = await insertCredential('orphan');
    await insertProvider({ credentialId: used.id });

    const snapshot = await store.loadSnapshot(1);
    expect(snapshot.credentials.has(used.id)).toBe(true);
    expect(snapshot.credentials.has(orphan.id)).toBe(false);
  });

  it('returns empty maps on an empty catalog', async () => {
    const snapshot = await store.loadSnapshot(3);
    expect(snapshot.byAlias.size).toBe(0);
    expect(snapshot.providers.size).toBe(0);
    expect(snapshot.credentials.size).toBe(0);
    expect(snapshot.loadedAt).toBeInstanceOf(Date);
  });

  it('keeps numeric price columns as decimal strings', async () => {
    const provider = await insertProvider();
    await insertModel(provider.id, { priceInputPerMtok: '3.500000' });

    const snapshot = await store.loadSnapshot(1);
    const model = (snapshot.byAlias.get('claude-opus-5') ?? [])[0];
    expect(model.priceInputPerMtok).toBe('3.500000');
    expect(typeof model.priceInputPerMtok).toBe('string');
  });
});
