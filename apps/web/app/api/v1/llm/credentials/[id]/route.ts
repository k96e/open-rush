/**
 * DELETE /api/v1/llm/credentials/:id
 *
 * 平台级资源 → **session-only**（service token 一律 403），与列表/录入同一条规则。
 * Auth scope：`llm:write`。
 *
 * 仍被 provider 引用时返回 409：`llm_providers.credential_id` 的外键是
 * `onDelete: 'restrict'`，硬删会在 DB 层被拒。这里先查一次引用数，把
 * 「被几个 provider 用着」这条可行动信息告诉调用方，FK 仍是最终防线。
 *
 * 删除成功后必须 `bumpCatalogVersion`——否则 router 副本会继续拿着一份已经
 * 不存在的凭据转发。
 */
import { v1 } from '@open-rush/contracts';
import { CredentialInUseError } from '@open-rush/llm-router';

import { v1Error, v1Success, v1ValidationError } from '@/lib/api/v1-responses';
import { authenticate, hasScope } from '@/lib/auth/unified-auth';

import { bumpCatalogAfterWrite, credentialStore } from '../helpers';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request);
  if (!auth) return v1Error('UNAUTHORIZED', 'Authentication required');
  if (!hasScope(auth, 'llm:write')) return v1Error('FORBIDDEN', 'Missing scope llm:write');
  if (auth.authType !== 'session') {
    return v1Error('FORBIDDEN', 'LLM credentials are platform-scoped and require a session', {
      hint: 'Service tokens cannot manage provider credentials',
    });
  }

  const { id } = await params;
  const parsed = v1.llmResourceParamsSchema.safeParse({ id });
  if (!parsed.success) return v1ValidationError(parsed.error);

  try {
    const deleted = await credentialStore().deleteById(parsed.data.id);
    if (!deleted) return v1Error('NOT_FOUND', `Credential ${parsed.data.id} not found`);
  } catch (err) {
    if (err instanceof CredentialInUseError) {
      return v1Error(
        'VERSION_CONFLICT',
        `Credential ${parsed.data.id} is still referenced by ${err.providerCount} provider(s)`,
        { hint: 'Detach or delete the referencing providers first' }
      );
    }
    throw err;
  }

  await bumpCatalogAfterWrite(parsed.data.id);
  return v1Success({ id: parsed.data.id, deleted: true as const });
}
