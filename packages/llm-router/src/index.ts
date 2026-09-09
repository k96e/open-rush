/**
 * `@open-rush/llm-router` —— 统一模型路由网关的库层（specs/llm-router.md）。
 *
 * 服务进程是 `apps/llm-router`（M4）；本包只放可被 web / worker / 网关共享的
 * 纯逻辑与数据访问。
 *
 * ⚠️ 密钥边界：`openSealed` / `loadRouterPrivateKey` 只允许在 llm-router 进程内
 * 调用。apps/web 与 packages/control-plane 里出现它们即违反 A11，
 * `scripts/audit-no-plaintext-key.sh`（M7·T7.3）会 grep 到。
 */
export { DrizzleTokenStore } from './auth/drizzle-token-store.js';
export {
  extractToken,
  hashRouterToken,
  mintRouterToken,
  ROUTER_TOKEN_PREFIX,
  TokenAuthenticator,
  type TokenAuthenticatorOptions,
} from './auth/router-token.js';
export { isAliasAllowed, type Subject, type TokenStore } from './auth/token-store.js';
export {
  bumpCatalogVersion,
  CatalogStateMissingError,
  LLM_CATALOG_CHANNEL,
} from './catalog/bump-version.js';
export {
  CATALOG_CHANNEL,
  CatalogCache,
  type CatalogCacheLogger,
  type CatalogCacheOptions,
  type Listener,
  type RefreshTrigger,
} from './catalog/catalog-cache.js';
export type { CatalogStore } from './catalog/catalog-store.js';
export { DrizzleCatalogStore } from './catalog/drizzle-catalog-store.js';
export { isRouteError, type RouteError, resolveRoute } from './catalog/resolve-route.js';
export type {
  CatalogAuthStyle,
  CatalogCredential,
  CatalogModel,
  CatalogProtocol,
  CatalogProvider,
  CatalogRouteMode,
  ResolvedRoute,
  Snapshot,
} from './catalog/types.js';
export {
  loadRouterPrivateKey,
  type RouterKeyEnv,
  type RouterKeyMaterial,
} from './crypto/key-loader.js';
export {
  computeKeyId,
  generateRouterKeyPair,
  openSealed,
  SEALED_BOX_ALG,
  type SealedEnvelope,
  seal,
} from './crypto/sealed-box.js';
export {
  type CallRecord,
  type CallRecorder,
  InMemoryCallRecorder,
  NOOP_CALL_RECORDER,
} from './metering/call-record.js';
export { classifyFetchError, type ForwardInput, forward } from './proxy/forward.js';
export {
  buildUpstreamHeaders,
  extractGroupingHints,
  stripHopByHop,
} from './proxy/headers.js';
export { ModelRewriteError, rewriteModelField } from './proxy/model-rewrite.js';
export {
  type InjectResult,
  injectStreamIncludeUsage,
} from './proxy/openai-stream-options.js';
export {
  type CallStatus,
  ROUTER_ERRORS,
  type RouterErrorKind,
  type RouterErrorSpec,
  routerErrorBody,
  routerErrorResponse,
} from './proxy/router-errors.js';
export { type TeeHooks, teeForMetering } from './proxy/sse-tee.js';
export { CatalogConflictError, CatalogReferenceError } from './store/catalog-errors.js';
export {
  type CreateCredentialInput,
  CredentialInUseError,
  CredentialNameConflictError,
  type CredentialSummary,
  DrizzleCredentialStore,
  decodeCredentialCursor,
  encodeCredentialCursor,
  type ListCredentialsOptions,
  type ListCredentialsResult,
} from './store/credential-store.js';
export {
  clampLimit,
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursor,
} from './store/cursor.js';
export {
  type CreateModelInput,
  DrizzleModelStore,
  type ListModelsOptions,
  type ListModelsResult,
  type ModelRow,
  type PatchModelInput,
} from './store/model-store.js';
export {
  type CreateProviderInput,
  DrizzleProviderStore,
  type ListProvidersOptions,
  type ListProvidersResult,
  normalizeBaseUrl,
  type PatchProviderInput,
  type ProviderRow,
} from './store/provider-store.js';
export { AnthropicSseUsageParser } from './usage/anthropic-parser.js';
export {
  computeCostUsd,
  formatMicrosUsd,
  type ModelPricing,
  parsePriceToMicros,
} from './usage/cost.js';
export { OpenAiSseUsageParser } from './usage/openai-parser.js';
export {
  EMPTY_WIRE_USAGE,
  type UsageParser,
  type UsageResult,
  type WireUsage,
} from './usage/types.js';
