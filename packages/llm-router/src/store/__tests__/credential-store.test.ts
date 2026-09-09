/**
 * DrizzleCredentialStore 单测（M2·T2.3）。
 *
 * 除了常规 CRUD，重点守住三条密钥边界不变量：
 *  - `list()` / `findById()` 返回的对象里**结构上没有** sealedValue
 *  - `rotate()` 覆盖密文、version++、rotated_at 更新，且**旧密文不可还原**
 *  - 被 provider 引用的凭据删不掉（FK restrict + 可行动的错误信息）
 */
import type { PGlite } from '@electric-sql/pglite';
import { llmCredentials, llmProviders } from '@open-rush/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, createTestDb, type TestDb, truncateAll } from '../../../test/pglite.js';
import { generateRouterKeyPair, openSealed, seal } from '../../crypto/sealed-box.js';
import {
  CredentialInUseError,
  CredentialNameConflictError,
  DrizzleCredentialStore,
  decodeCredentialCursor,
  encodeCredentialCursor,
} from '../credential-store.js';

let db: TestDb;
let pglite: PGlite;
let store: DrizzleCredentialStore;

const pair = generateRouterKeyPair();

beforeAll(async () => {
  const result = await createTestDb();
  db = result.db;
  pglite = result.pglite;
  store = new DrizzleCredentialStore(db as never);
}, 30000);

afterAll(async () => {
  await closeTestDb(pglite);
}, 30000);

beforeEach(async () => {
  await truncateAll(db);
});

function sealedInput(name: string, plaintext: string) {
  const env = seal(pair.publicKeyPem, plaintext);
  return {
    name,
    alg: env.alg,
    keyId: env.keyId,
    sealedValue: env.value,
    authStyle: 'bearer',
    authHeader: null,
    createdBy: null,
  };
}

describe('DrizzleCredentialStore.create', () => {
  it('stores the ciphertext and returns a summary without it', async () => {
    const created = await store.create(sealedInput('anthropic-prod', 'sk-ant-secret'));

    expect(created.name).toBe('anthropic-prod');
    expect(created.version).toBe(1);
    expect(created.rotatedAt).toBeNull();
    expect(created.keyId).toBe(pair.keyId);
    expect(JSON.stringify(created)).not.toContain('sealedValue');
    expect(JSON.stringify(created)).not.toContain('sk-ant-secret');

    // 库里存的确实是密文，且能被私钥解回来。
    const [row] = await db.select().from(llmCredentials).where(eq(llmCredentials.id, created.id));
    expect(row.sealedValue).not.toContain('sk-ant-secret');
    expect(
      openSealed(pair.privateKeyPem, { alg: row.alg, keyId: row.keyId, value: row.sealedValue })
    ).toBe('sk-ant-secret');
  });

  it('maps a duplicate name to CredentialNameConflictError', async () => {
    await store.create(sealedInput('anthropic-prod', 'sk-ant-one'));
    await expect(store.create(sealedInput('anthropic-prod', 'sk-ant-two'))).rejects.toBeInstanceOf(
      CredentialNameConflictError
    );
  });

  it('honours the authStyle=header CHECK constraint', async () => {
    await expect(
      store.create({ ...sealedInput('bad-header', 'sk-ant-x'), authStyle: 'header' })
    ).rejects.toThrow();

    const ok = await store.create({
      ...sealedInput('good-header', 'sk-ant-x'),
      authStyle: 'header',
      authHeader: 'x-goog-api-key',
    });
    expect(ok.authHeader).toBe('x-goog-api-key');
  });
});

describe('DrizzleCredentialStore.list', () => {
  it('returns newest-first and never exposes the ciphertext', async () => {
    await store.create(sealedInput('first', 'sk-ant-1'));
    await store.create(sealedInput('second', 'sk-ant-2'));

    const { items, nextCursor } = await store.list();
    expect(items.map((c) => c.name)).toEqual(['second', 'first']);
    expect(nextCursor).toBeNull();
    expect(JSON.stringify(items)).not.toContain('sealedValue');
  });

  it('paginates deterministically through a keyset cursor', async () => {
    for (let i = 0; i < 5; i++) await store.create(sealedInput(`cred-${i}`, `sk-ant-${i}`));

    const page1 = await store.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await store.list({ limit: 2, cursor: page1.nextCursor ?? undefined });
    const page3 = await store.list({ limit: 2, cursor: page2.nextCursor ?? undefined });

    const seen = [...page1.items, ...page2.items, ...page3.items].map((c) => c.name);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(page3.nextCursor).toBeNull();
  });

  it('treats a malformed cursor as "first page" rather than erroring', async () => {
    await store.create(sealedInput('only', 'sk-ant-1'));
    const { items } = await store.list({ cursor: 'not-a-cursor' });
    expect(items).toHaveLength(1);
  });

  it('clamps the limit into 1..200', async () => {
    for (let i = 0; i < 3; i++) await store.create(sealedInput(`c-${i}`, `sk-ant-${i}`));
    expect((await store.list({ limit: 0 })).items).toHaveLength(3);
    expect((await store.list({ limit: 1 })).items).toHaveLength(1);
    expect((await store.list({ limit: 9999 })).items).toHaveLength(3);
  });
});

describe('credential cursor codec', () => {
  it('round-trips (createdAt, id)', () => {
    const createdAt = new Date('2026-09-08T10:11:12.345Z');
    const id = '00000000-0000-0000-0000-0000000000aa';
    const decoded = decodeCredentialCursor(encodeCredentialCursor(createdAt, id));
    expect(decoded?.id).toBe(id);
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it('returns null for undefined / malformed / non-date input', () => {
    expect(decodeCredentialCursor(undefined)).toBeNull();
    expect(decodeCredentialCursor('!!!')).toBeNull();
    expect(decodeCredentialCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull();
    expect(decodeCredentialCursor(Buffer.from('nope|abc').toString('base64url'))).toBeNull();
  });
});

describe('DrizzleCredentialStore.findById / findSealedById', () => {
  it('findById omits the ciphertext; findSealedById returns it for the router only', async () => {
    const created = await store.create(sealedInput('anthropic-prod', 'sk-ant-secret'));

    const summary = await store.findById(created.id);
    expect(summary?.name).toBe('anthropic-prod');
    expect(JSON.stringify(summary)).not.toContain('sealedValue');

    const sealedRow = await store.findSealedById(created.id);
    if (!sealedRow) throw new Error('expected findSealedById to return the ciphertext row');
    expect(
      openSealed(pair.privateKeyPem, {
        alg: sealedRow.alg,
        keyId: sealedRow.keyId,
        value: sealedRow.sealedValue,
      })
    ).toBe('sk-ant-secret');
  });

  it('returns null for an unknown id', async () => {
    const missing = '00000000-0000-0000-0000-0000000000ff';
    expect(await store.findById(missing)).toBeNull();
    expect(await store.findSealedById(missing)).toBeNull();
  });
});

describe('DrizzleCredentialStore.rotate', () => {
  it('overwrites the ciphertext, bumps version, sets rotatedAt', async () => {
    const created = await store.create(sealedInput('anthropic-prod', 'sk-ant-old'));
    const [before] = await db
      .select()
      .from(llmCredentials)
      .where(eq(llmCredentials.id, created.id));

    const next = seal(pair.publicKeyPem, 'sk-ant-new');
    const rotated = await store.rotate(created.id, {
      alg: next.alg,
      keyId: next.keyId,
      sealedValue: next.value,
    });

    expect(rotated?.version).toBe(2);
    expect(rotated?.rotatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(rotated)).not.toContain('sealedValue');

    const [after] = await db.select().from(llmCredentials).where(eq(llmCredentials.id, created.id));
    // A8：旧密文被覆盖，持久层里再也还原不出旧密钥。
    expect(after.sealedValue).not.toBe(before.sealedValue);
    expect(
      openSealed(pair.privateKeyPem, {
        alg: after.alg,
        keyId: after.keyId,
        value: after.sealedValue,
      })
    ).toBe('sk-ant-new');
  });

  it('returns null for an unknown id', async () => {
    const next = seal(pair.publicKeyPem, 'sk-ant-new');
    const rotated = await store.rotate('00000000-0000-0000-0000-0000000000ff', {
      alg: next.alg,
      keyId: next.keyId,
      sealedValue: next.value,
    });
    expect(rotated).toBeNull();
  });
});

describe('DrizzleCredentialStore.deleteById', () => {
  it('deletes an unreferenced credential', async () => {
    const created = await store.create(sealedInput('anthropic-prod', 'sk-ant-secret'));
    expect(await store.deleteById(created.id)).toBe(true);
    expect(await store.findById(created.id)).toBeNull();
  });

  it('returns false for an unknown id', async () => {
    expect(await store.deleteById('00000000-0000-0000-0000-0000000000ff')).toBe(false);
  });

  it('refuses to delete a credential still referenced by a provider', async () => {
    const created = await store.create(sealedInput('anthropic-prod', 'sk-ant-secret'));
    await db.insert(llmProviders).values({
      name: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      credentialId: created.id,
    });

    await expect(store.deleteById(created.id)).rejects.toBeInstanceOf(CredentialInUseError);
    // 凭据仍在——restrict 不是软失败。
    expect(await store.findById(created.id)).not.toBeNull();
  });
});
