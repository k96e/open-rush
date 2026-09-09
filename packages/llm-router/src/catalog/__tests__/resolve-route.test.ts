/**
 * resolveRoute 单测（M3·T3.3，A4）。
 *
 * 快照是手工构造的——路由本身是纯函数，用假快照才能覆到「provider 不在 map 里」
 * 这种真库加载路径造不出来的防御分支。
 */
import { describe, expect, it } from 'vitest';
import { isRouteError, resolveRoute } from '../resolve-route.js';
import type { CatalogCredential, CatalogModel, CatalogProvider, Snapshot } from '../types.js';

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    alias: 'claude-opus-5',
    providerId: 'provider-1',
    upstreamModel: 'claude-opus-5',
    priority: 0,
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

function provider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: 'provider-1',
    name: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    credentialId: null,
    defaultHeaders: {},
    timeoutMs: 600_000,
    ...overrides,
  };
}

function credential(overrides: Partial<CatalogCredential> = {}): CatalogCredential {
  return {
    id: 'cred-1',
    name: 'anthropic-prod',
    alg: 'x25519-hkdf-sha256-aes256gcm',
    keyId: 'a'.repeat(32),
    sealedValue: 'SEALED-BASE64',
    authStyle: 'x-api-key',
    authHeader: null,
    version: 1,
    ...overrides,
  };
}

function snapshot(parts: {
  models?: CatalogModel[];
  providers?: CatalogProvider[];
  credentials?: CatalogCredential[];
}): Snapshot {
  const byAlias = new Map<string, CatalogModel[]>();
  for (const m of parts.models ?? []) {
    const bucket = byAlias.get(m.alias);
    if (bucket) bucket.push(m);
    else byAlias.set(m.alias, [m]);
  }
  return {
    version: 1,
    loadedAt: new Date(),
    byAlias,
    providers: new Map((parts.providers ?? []).map((p) => [p.id, p])),
    credentials: new Map((parts.credentials ?? []).map((c) => [c.id, c])),
  };
}

describe('resolveRoute', () => {
  it('resolves a hit to its provider and credential', () => {
    const result = resolveRoute(
      snapshot({
        models: [model()],
        providers: [provider({ credentialId: 'cred-1' })],
        credentials: [credential()],
      }),
      'claude-opus-5'
    );

    expect(isRouteError(result)).toBe(false);
    if (isRouteError(result)) return;
    expect(result.provider.name).toBe('anthropic');
    expect(result.credential?.id).toBe('cred-1');
  });

  it('returns model_not_found for an unknown alias, echoing only the alias', () => {
    const result = resolveRoute(
      snapshot({ models: [model({ alias: 'secret-internal-model' })], providers: [provider()] }),
      'gpt-9'
    );

    expect(result).toEqual({ kind: 'model_not_found', alias: 'gpt-9' });
    // A4：404 不得回显目录内容，否则任何持令牌的调用方都能枚举出整份目录。
    expect(JSON.stringify(result)).not.toContain('secret-internal-model');
  });

  it('returns model_not_found when everything is disabled (empty snapshot)', () => {
    const result = resolveRoute(snapshot({}), 'claude-opus-5');
    expect(result).toEqual({ kind: 'model_not_found', alias: 'claude-opus-5' });
  });

  it('picks the lowest-priority candidate among several', () => {
    const cheap = model({ id: 'm-cheap', providerId: 'p-cheap', priority: 1 });
    const dear = model({ id: 'm-dear', providerId: 'p-dear', priority: 10 });
    const result = resolveRoute(
      snapshot({
        // 快照的候选数组已由 store 排好序，这里按同样的次序给。
        models: [cheap, dear],
        providers: [provider({ id: 'p-cheap' }), provider({ id: 'p-dear', name: 'bedrock' })],
      }),
      'claude-opus-5'
    );

    expect(isRouteError(result)).toBe(false);
    if (isRouteError(result)) return;
    expect(result.model.id).toBe('m-cheap');
  });

  it('is passthrough when alias === upstreamModel and rewrite-model otherwise', () => {
    const same = resolveRoute(
      snapshot({ models: [model()], providers: [provider()] }),
      'claude-opus-5'
    );
    const renamed = resolveRoute(
      snapshot({
        models: [model({ alias: 'fast', upstreamModel: 'claude-haiku-4-5' })],
        providers: [provider()],
      }),
      'fast'
    );

    expect(isRouteError(same) ? null : same.mode).toBe('passthrough');
    expect(isRouteError(renamed) ? null : renamed.mode).toBe('rewrite-model');
  });

  it('yields a null credential when the provider has none bound', () => {
    const result = resolveRoute(
      snapshot({ models: [model()], providers: [provider({ credentialId: null })] }),
      'claude-opus-5'
    );
    expect(isRouteError(result) ? null : result.credential).toBeNull();
  });

  it('yields a null credential when the referenced credential is missing from the snapshot', () => {
    const result = resolveRoute(
      snapshot({ models: [model()], providers: [provider({ credentialId: 'gone' })] }),
      'claude-opus-5'
    );
    expect(isRouteError(result) ? null : result.credential).toBeNull();
  });

  it('treats a dangling providerId as model_not_found instead of throwing', () => {
    const result = resolveRoute(
      snapshot({ models: [model({ providerId: 'missing' })], providers: [] }),
      'claude-opus-5'
    );
    expect(result).toEqual({ kind: 'model_not_found', alias: 'claude-opus-5' });
  });

  it('treats an empty candidate array as model_not_found', () => {
    const empty: Snapshot = {
      version: 1,
      loadedAt: new Date(),
      byAlias: new Map([['claude-opus-5', []]]),
      providers: new Map(),
      credentials: new Map(),
    };
    expect(resolveRoute(empty, 'claude-opus-5')).toEqual({
      kind: 'model_not_found',
      alias: 'claude-opus-5',
    });
  });
});
