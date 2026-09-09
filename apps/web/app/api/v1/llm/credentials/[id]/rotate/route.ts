/**
 * POST /api/v1/llm/credentials/:id/rotate
 *
 * 轮换 = 用公钥封装新的明文 `value`，**覆盖** `sealed_value`、`version++`、
 * `rotated_at = now()`。**不保留历史密文**——这正是 A8 里「旧密钥不可从持久层
 * 还原」的兑现点：轮换完成的那一刻，旧密钥在库里就不存在了。
 *
 * 平台级资源 → session-only；Auth scope `llm:write`。
 *
 * 密钥边界：与 POST 同规矩——`seal()` 之后不再引用明文，响应走
 * `credentialToV1()` 显式投影，绝不回显密文。
 */
import { v1 } from '@open-rush/contracts';

import { v1Error, v1Success, v1ValidationError } from '@/lib/api/v1-responses';
import { authenticate, hasScope } from '@/lib/auth/unified-auth';

import {
  bumpCatalogAfterWrite,
  credentialStore,
  credentialToV1,
  resolveRouterPublicKey,
  sealCredentialValue,
} from '../../helpers';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request);
  if (!auth) return v1Error('UNAUTHORIZED', 'Authentication required');
  if (!hasScope(auth, 'llm:write')) return v1Error('FORBIDDEN', 'Missing scope llm:write');
  if (auth.authType !== 'session') {
    return v1Error('FORBIDDEN', 'LLM credentials are platform-scoped and require a session', {
      hint: 'Service tokens cannot rotate provider credentials',
    });
  }

  const { id } = await params;
  const paramsParsed = v1.llmResourceParamsSchema.safeParse({ id });
  if (!paramsParsed.success) return v1ValidationError(paramsParsed.error);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return v1Error('VALIDATION_ERROR', 'Invalid JSON body');
  }

  const parsed = v1.rotateLlmCredentialRequestSchema.safeParse(body);
  if (!parsed.success) return v1ValidationError(parsed.error);

  const key = resolveRouterPublicKey();
  if (key.error) return key.error;

  const sealed = sealCredentialValue(key.publicKeyPem, parsed.data.value);
  if (sealed.error) return sealed.error;
  // ↑ 从这里往下，明文 `parsed.data.value` 不再被引用。

  const rotated = await credentialStore().rotate(paramsParsed.data.id, {
    alg: sealed.envelope.alg,
    keyId: sealed.envelope.keyId,
    sealedValue: sealed.envelope.value,
  });
  if (!rotated) return v1Error('NOT_FOUND', `Credential ${paramsParsed.data.id} not found`);

  await bumpCatalogAfterWrite(rotated.id);
  return v1Success(credentialToV1(rotated));
}
