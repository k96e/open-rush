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
export {
  bumpCatalogVersion,
  CatalogStateMissingError,
  LLM_CATALOG_CHANNEL,
} from './catalog/bump-version.js';
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
