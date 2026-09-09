/**
 * /api/v1/llm/credentials
 *   - POST — **录入即盲写**：body 传明文 `value`，服务端立刻用公钥 seal，
 *            只落密文；响应不含任何密文/明文
 *   - GET  — 列表，只返回 `{id,name,keyId,alg,authStyle,authHeader,version,…}`
 *
 * Auth scope（specs/service-token-auth.md §Scope 定义）：
 *   - POST → `llm:write`
 *   - GET  → `llm:read`
 *
 * **平台级资源**：凭据不属于任何 project，按仓库既有惯例（见
 * `/api/v1/vaults/entries` 对 `scope=platform` 的处理）**只接受 session 认证，
 * 拒绝 service token**——沙箱里的机器凭据不该能翻出供应商密钥的元数据。
 *
 * 密钥边界（specs/llm-router.md §密钥边界，盲写不变量 2–3）：
 * - `seal()` 之后**立刻停止引用** `parsed.data.value`：不进日志、不进错误信息、
 *   不进响应体。本文件此后再没有出现过那个标识符。
 * - 响应一律走 `credentialToV1()` 显式投影——`v1Success<T>` 是无约束泛型、
 *   不跑 schema，类型层挡不住 spread 出来的密文。
 * - web 侧物理上没有私钥：解封函数与 router 私钥环境变量都不得出现在本目录，
 *   M7·T7.3 的审计脚本会 grep 这两个标识符（所以注释里也不写它们的字面量）。
 *
 * 目录热变更（D7）：写成功后 `bumpCatalogVersion(db)`，否则 router 副本永远
 * 看不到这条凭据。bump 失败**不回滚**已提交的写——资源确实已经存在，谎报 500
 * 会让客户端重试并撞上 409。改为记一条 error 日志，说明「下一次目录写会顺带
 * 带上它」这个后果。
 */

import { v1 } from '@open-rush/contracts';
import { CredentialNameConflictError } from '@open-rush/llm-router';

import { v1Error, v1Paginated, v1Success, v1ValidationError } from '@/lib/api/v1-responses';
import { authenticate, hasScope } from '@/lib/auth/unified-auth';

import {
  bumpCatalogAfterWrite,
  credentialStore,
  credentialToV1,
  resolveRouterPublicKey,
  sealCredentialValue,
} from './helpers';

// ---------------------------------------------------------------------------
// POST /api/v1/llm/credentials
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return v1Error('UNAUTHORIZED', 'Authentication required');
  if (!hasScope(auth, 'llm:write')) return v1Error('FORBIDDEN', 'Missing scope llm:write');
  if (auth.authType !== 'session') {
    return v1Error('FORBIDDEN', 'LLM credentials are platform-scoped and require a session', {
      hint: 'Service tokens cannot manage provider credentials',
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return v1Error('VALIDATION_ERROR', 'Invalid JSON body');
  }

  const parsed = v1.createLlmCredentialRequestSchema.safeParse(body);
  if (!parsed.success) return v1ValidationError(parsed.error);

  const key = resolveRouterPublicKey();
  if (key.error) return key.error;

  const sealed = sealCredentialValue(key.publicKeyPem, parsed.data.value);
  if (sealed.error) return sealed.error;
  // ↑ 从这里往下，明文 `parsed.data.value` 不再被引用。

  try {
    const created = await credentialStore().create({
      name: parsed.data.name,
      alg: sealed.envelope.alg,
      keyId: sealed.envelope.keyId,
      sealedValue: sealed.envelope.value,
      authStyle: parsed.data.authStyle,
      authHeader: parsed.data.authHeader ?? null,
      createdBy: auth.userId,
    });
    await bumpCatalogAfterWrite(created.id);
    return v1Success(credentialToV1(created), 201);
  } catch (err) {
    if (err instanceof CredentialNameConflictError) {
      return v1Error('VERSION_CONFLICT', `Credential '${parsed.data.name}' already exists`, {
        hint: 'Use POST /api/v1/llm/credentials/:id/rotate to replace an existing key',
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/llm/credentials
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return v1Error('UNAUTHORIZED', 'Authentication required');
  if (!hasScope(auth, 'llm:read')) return v1Error('FORBIDDEN', 'Missing scope llm:read');
  if (auth.authType !== 'session') {
    return v1Error('FORBIDDEN', 'LLM credentials are platform-scoped and require a session', {
      hint: 'Service tokens cannot read provider credentials',
    });
  }

  const url = new URL(request.url);
  const parsed = v1.listLlmCredentialsQuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });
  if (!parsed.success) return v1ValidationError(parsed.error);

  const { items, nextCursor } = await credentialStore().list({
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  });
  return v1Paginated(items.map(credentialToV1), nextCursor);
}
