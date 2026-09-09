/**
 * DrizzleProviderStore 单测（M3·T3.4）。
 *
 * 重点在真库上跑那几条只有 PostgreSQL 才会告诉你的分支：
 *  - name 唯一 → CatalogConflictError
 *  - credential_id 指向不存在的凭据 → CatalogReferenceError
 *  - 删 provider 会级联删它名下的 model（FK ON DELETE CASCADE）
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmCredentials, llmModels } from '@open-rush/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import { CatalogConflictError, CatalogReferenceError } from '../catalog-errors.js';
import {
  type CreateProviderInput,
  DrizzleProviderStore,
  normalizeBaseUrl,
} from '../provider-store.js';

let db: TestDb;
let pglite: PGlite;
let store: DrizzleProviderStore;

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
  store = new DrizzleProviderStore(db as never);
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

function input(overrides: Partial<CreateProviderInput> = {}): CreateProviderInput {
  return {
    name: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    credentialId: null,
    defaultHeaders: {},
    timeoutMs: 600_000,
    enabled: true,
    ...overrides,
  };
}

async function insertCredential(name = 'anthropic-prod') {
  const [row] = await db
    .insert(llmCredentials)
    .values({ name, keyId: 'a'.repeat(32), sealedValue: 'SEALED' })
    .returning();
  return row;
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com/')).toBe('https://api.anthropic.com');
    expect(normalizeBaseUrl('https://x.dev/v1//')).toBe('https://x.dev/v1');
    expect(normalizeBaseUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com');
  });
});

describe('DrizzleProviderStore.create', () => {
  it('inserts a provider and normalizes baseUrl', async () => {
    const row = await store.create(input({ baseUrl: 'https://api.anthropic.com/' }));
    expect(row.baseUrl).toBe('https://api.anthropic.com');
    expect(row.enabled).toBe(true);
    expect(row.defaultHeaders).toEqual({});
  });

  it('binds an existing credential', async () => {
    const credential = await insertCredential();
    const row = await store.create(input({ credentialId: credential.id }));
    expect(row.credentialId).toBe(credential.id);
  });

  it('rejects a duplicate name with CatalogConflictError', async () => {
    await store.create(input());
    await expect(store.create(input())).rejects.toBeInstanceOf(CatalogConflictError);
  });

  it('rejects an unknown credentialId with CatalogReferenceError', async () => {
    await expect(
      store.create(input({ credentialId: '00000000-0000-0000-0000-0000000000ff' }))
    ).rejects.toBeInstanceOf(CatalogReferenceError);
  });
});

describe('DrizzleProviderStore.list', () => {
  it('filters by enabled', async () => {
    await store.create(input({ name: 'on' }));
    await store.create(input({ name: 'off', enabled: false }));

    const enabled = await store.list({ enabled: true });
    expect(enabled.items.map((p) => p.name)).toEqual(['on']);

    const disabled = await store.list({ enabled: false });
    expect(disabled.items.map((p) => p.name)).toEqual(['off']);
  });

  it('paginates with a keyset cursor and stops at the last page', async () => {
    for (let i = 0; i < 3; i++) await store.create(input({ name: `p${i}` }));

    const first = await store.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const names = [...first.items, ...second.items].map((p) => p.name);
    expect(new Set(names).size).toBe(3);
  });

  it('keeps the enabled filter across pages', async () => {
    for (let i = 0; i < 3; i++) await store.create(input({ name: `on${i}` }));
    await store.create(input({ name: 'off', enabled: false }));

    const first = await store.list({ limit: 2, enabled: true });
    const second = await store.list({
      limit: 2,
      enabled: true,
      cursor: first.nextCursor ?? undefined,
    });
    expect([...first.items, ...second.items].every((p) => p.enabled)).toBe(true);
  });

  it('falls back to the first page on a malformed cursor', async () => {
    await store.create(input());
    const page = await store.list({ cursor: 'not-a-cursor' });
    expect(page.items).toHaveLength(1);
  });
});

describe('DrizzleProviderStore.patch', () => {
  it('updates only the given fields', async () => {
    const created = await store.create(input({ timeoutMs: 1000 }));
    const patched = await store.patch(created.id, { enabled: false });

    expect(patched?.enabled).toBe(false);
    expect(patched?.timeoutMs).toBe(1000);
    expect(patched?.name).toBe('anthropic');
    expect(patched?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('unbinds a credential when credentialId is explicitly null', async () => {
    const credential = await insertCredential();
    const created = await store.create(input({ credentialId: credential.id }));
    const patched = await store.patch(created.id, { credentialId: null });
    expect(patched?.credentialId).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(
      await store.patch('00000000-0000-0000-0000-0000000000ff', { enabled: false })
    ).toBeNull();
  });

  it('rejects a rename onto an existing name', async () => {
    await store.create(input({ name: 'taken' }));
    const other = await store.create(input({ name: 'other' }));
    await expect(store.patch(other.id, { name: 'taken' })).rejects.toBeInstanceOf(
      CatalogConflictError
    );
  });
});

describe('DrizzleProviderStore.deleteById', () => {
  it('deletes and reports whether a row was hit', async () => {
    const created = await store.create(input());
    expect(await store.deleteById(created.id)).toBe(true);
    expect(await store.deleteById(created.id)).toBe(false);
  });

  it('cascades to the provider models', async () => {
    const created = await store.create(input());
    await db.insert(llmModels).values({ alias: 'a', providerId: created.id, upstreamModel: 'a' });

    await store.deleteById(created.id);
    expect(await db.select().from(llmModels)).toHaveLength(0);
  });
});

describe('DrizzleProviderStore.findById', () => {
  it('returns the row or null', async () => {
    const created = await store.create(input());
    expect((await store.findById(created.id))?.name).toBe('anthropic');
    expect(await store.findById('00000000-0000-0000-0000-0000000000ff')).toBeNull();
  });
});
