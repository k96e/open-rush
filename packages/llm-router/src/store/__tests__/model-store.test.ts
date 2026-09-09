/**
 * DrizzleModelStore 单测（M3·T3.4）。
 *
 * 与 provider-store 同款，另加两条 model 特有的：
 *  - 唯一约束是 `(alias, provider_id)`——同名 alias 挂到**不同** provider 是合法的
 *    （多候选 + priority 就是这么用的）
 *  - numeric 价格列全程是 string，不能被 Number() 溜进来
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmProviders } from '@open-rush/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import { CatalogConflictError, CatalogReferenceError } from '../catalog-errors.js';
import { type CreateModelInput, DrizzleModelStore } from '../model-store.js';

let db: TestDb;
let pglite: PGlite;
let store: DrizzleModelStore;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
  store = new DrizzleModelStore(db as never);
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

async function insertProvider(name = 'anthropic') {
  const [row] = await db
    .insert(llmProviders)
    .values({ name, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' })
    .returning();
  return row;
}

function input(providerId: string, overrides: Partial<CreateModelInput> = {}): CreateModelInput {
  return {
    alias: 'claude-opus-5',
    providerId,
    upstreamModel: 'claude-opus-5',
    priority: 0,
    enabled: true,
    displayName: null,
    maxOutputTokens: null,
    priceInputPerMtok: '0',
    priceOutputPerMtok: '0',
    priceCacheWritePerMtok: '0',
    priceCacheReadPerMtok: '0',
    priceReasoningPerMtok: '0',
    ...overrides,
  };
}

describe('DrizzleModelStore.create', () => {
  it('inserts a model with its price list intact as strings', async () => {
    const provider = await insertProvider();
    const row = await store.create(
      input(provider.id, { priceInputPerMtok: '3.5', priceOutputPerMtok: '17.25' })
    );

    expect(row.alias).toBe('claude-opus-5');
    expect(row.priceInputPerMtok).toBe('3.500000');
    expect(row.priceOutputPerMtok).toBe('17.250000');
    expect(typeof row.priceInputPerMtok).toBe('string');
  });

  it('rejects a duplicate (alias, providerId) with CatalogConflictError', async () => {
    const provider = await insertProvider();
    await store.create(input(provider.id));
    await expect(store.create(input(provider.id))).rejects.toBeInstanceOf(CatalogConflictError);
  });

  it('allows the same alias under a different provider (multi-candidate routing)', async () => {
    const a = await insertProvider('a');
    const b = await insertProvider('b');
    await store.create(input(a.id));
    const second = await store.create(input(b.id, { priority: 10 }));
    expect(second.priority).toBe(10);
  });

  it('rejects an unknown providerId with CatalogReferenceError', async () => {
    await expect(
      store.create(input('00000000-0000-0000-0000-0000000000ff'))
    ).rejects.toBeInstanceOf(CatalogReferenceError);
  });
});

describe('DrizzleModelStore.list', () => {
  it('filters by providerId and enabled', async () => {
    const a = await insertProvider('a');
    const b = await insertProvider('b');
    await store.create(input(a.id, { alias: 'a-on' }));
    await store.create(input(a.id, { alias: 'a-off', enabled: false }));
    await store.create(input(b.id, { alias: 'b-on' }));

    const byProvider = await store.list({ providerId: a.id });
    expect(byProvider.items.map((m) => m.alias).sort()).toEqual(['a-off', 'a-on']);

    const enabledOnly = await store.list({ providerId: a.id, enabled: true });
    expect(enabledOnly.items.map((m) => m.alias)).toEqual(['a-on']);
  });

  it('paginates with a keyset cursor', async () => {
    const provider = await insertProvider();
    for (let i = 0; i < 3; i++) await store.create(input(provider.id, { alias: `m${i}` }));

    const first = await store.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await store.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((m) => m.alias)).size).toBe(3);
  });

  it('keeps filters across pages', async () => {
    const provider = await insertProvider();
    for (let i = 0; i < 3; i++) await store.create(input(provider.id, { alias: `on${i}` }));
    await store.create(input(provider.id, { alias: 'off', enabled: false }));

    const first = await store.list({ limit: 2, enabled: true });
    const second = await store.list({
      limit: 2,
      enabled: true,
      cursor: first.nextCursor ?? undefined,
    });
    const all = [...first.items, ...second.items];
    expect(all).toHaveLength(3);
    expect(all.every((m) => m.enabled)).toBe(true);
  });
});

describe('DrizzleModelStore.patch', () => {
  it('updates only the given fields', async () => {
    const provider = await insertProvider();
    const created = await store.create(input(provider.id, { priority: 5 }));
    const patched = await store.patch(created.id, { enabled: false });

    expect(patched?.enabled).toBe(false);
    expect(patched?.priority).toBe(5);
  });

  it('can null out displayName without touching the rest', async () => {
    const provider = await insertProvider();
    const created = await store.create(input(provider.id, { displayName: 'Opus' }));
    const patched = await store.patch(created.id, { displayName: null });
    expect(patched?.displayName).toBeNull();
    expect(patched?.alias).toBe('claude-opus-5');
  });

  it('returns null for an unknown id', async () => {
    expect(await store.patch('00000000-0000-0000-0000-0000000000ff', { priority: 1 })).toBeNull();
  });

  it('rejects a rename onto an existing (alias, providerId)', async () => {
    const provider = await insertProvider();
    await store.create(input(provider.id, { alias: 'taken' }));
    const other = await store.create(input(provider.id, { alias: 'other' }));
    await expect(store.patch(other.id, { alias: 'taken' })).rejects.toBeInstanceOf(
      CatalogConflictError
    );
  });

  it('rejects a move onto an unknown provider', async () => {
    const provider = await insertProvider();
    const created = await store.create(input(provider.id));
    await expect(
      store.patch(created.id, { providerId: '00000000-0000-0000-0000-0000000000ff' })
    ).rejects.toBeInstanceOf(CatalogReferenceError);
  });
});

describe('DrizzleModelStore.deleteById / findById', () => {
  it('deletes once and reports misses', async () => {
    const provider = await insertProvider();
    const created = await store.create(input(provider.id));
    expect(await store.deleteById(created.id)).toBe(true);
    expect(await store.deleteById(created.id)).toBe(false);
  });

  it('finds a row or returns null', async () => {
    const provider = await insertProvider();
    const created = await store.create(input(provider.id));
    expect((await store.findById(created.id))?.alias).toBe('claude-opus-5');
    expect(await store.findById('00000000-0000-0000-0000-0000000000ff')).toBeNull();
  });
});
