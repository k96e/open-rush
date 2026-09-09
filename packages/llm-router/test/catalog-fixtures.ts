/**
 * 目录/路由的测试夹具：造一条 {@link ResolvedRoute} 与一对真密钥。
 */
import type {
  CatalogAuthStyle,
  CatalogCredential,
  CatalogModel,
  CatalogProtocol,
  CatalogProvider,
  CatalogRouteMode,
  ResolvedRoute,
} from '../src/catalog/types.js';
import { generateRouterKeyPair, seal } from '../src/crypto/sealed-box.js';

export const KEYPAIR = generateRouterKeyPair();

export function makeCredential(
  plaintext: string,
  over: Partial<Omit<CatalogCredential, 'alg' | 'keyId' | 'sealedValue'>> & {
    authStyle?: CatalogAuthStyle;
  } = {}
): CatalogCredential {
  const envelope = seal(KEYPAIR.publicKeyPem, plaintext);
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

export function makeProvider(over: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: 'prov-1',
    name: 'anthropic',
    protocol: 'anthropic' as CatalogProtocol,
    baseUrl: 'http://127.0.0.1:1',
    credentialId: 'cred-1',
    defaultHeaders: {},
    timeoutMs: 5_000,
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

export function makeRoute(
  over: {
    model?: Partial<CatalogModel>;
    provider?: Partial<CatalogProvider>;
    credential?: CatalogCredential | null;
    mode?: CatalogRouteMode;
  } = {}
): ResolvedRoute {
  const model = makeModel(over.model);
  return {
    model,
    provider: makeProvider(over.provider),
    credential:
      over.credential === undefined ? makeCredential('sk-upstream-secret') : over.credential,
    mode: over.mode ?? (model.alias === model.upstreamModel ? 'passthrough' : 'rewrite-model'),
  };
}
