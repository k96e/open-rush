/**
 * /api/v1/llm/providers/:id
 *   - GET    — 单条
 *   - PATCH  — 部分更新（至少给一个字段；空 patch 会被契约挡下）
 *   - DELETE — 删除
 *
 * Auth scope：GET → `llm:read`，PATCH/DELETE → `llm:write`。平台级资源 → session-only。
 *
 * ⚠️ DELETE 会**级联删掉这个 provider 名下的所有 model**（`llm_models.provider_id`
 * 是 `ON DELETE CASCADE`，R4 §5.4）。这是既定 schema 决策，响应的 hint 里说明白，
 * 免得调用方以为只是解绑。
 */
import { v1 } from '@open-rush/contracts';
import { CatalogConflictError, CatalogReferenceError } from '@open-rush/llm-router';

import { v1Error, v1Success, v1ValidationError } from '@/lib/api/v1-responses';

import {
  bumpCatalogAfterWrite,
  providerStore,
  providerToV1,
  requireLlmConsole,
} from '../../catalog-helpers';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const gate = await requireLlmConsole(request, 'llm:read');
  if (gate.error) return gate.error;

  const parsed = v1.llmResourceParamsSchema.safeParse({ id: (await params).id });
  if (!parsed.success) return v1ValidationError(parsed.error);

  const row = await providerStore().findById(parsed.data.id);
  if (!row) return v1Error('NOT_FOUND', `Provider ${parsed.data.id} not found`);
  return v1Success(providerToV1(row));
}

export async function PATCH(request: Request, { params }: Ctx) {
  const gate = await requireLlmConsole(request, 'llm:write');
  if (gate.error) return gate.error;

  const parsedParams = v1.llmResourceParamsSchema.safeParse({ id: (await params).id });
  if (!parsedParams.success) return v1ValidationError(parsedParams.error);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return v1Error('VALIDATION_ERROR', 'Invalid JSON body');
  }

  const parsed = v1.patchLlmProviderRequestSchema.safeParse(body);
  if (!parsed.success) return v1ValidationError(parsed.error);

  try {
    const updated = await providerStore().patch(parsedParams.data.id, parsed.data);
    if (!updated) return v1Error('NOT_FOUND', `Provider ${parsedParams.data.id} not found`);
    await bumpCatalogAfterWrite(`provider ${updated.id}`);
    return v1Success(providerToV1(updated));
  } catch (err) {
    if (err instanceof CatalogConflictError) {
      return v1Error('VERSION_CONFLICT', err.message);
    }
    if (err instanceof CatalogReferenceError) {
      return v1Error('VALIDATION_ERROR', err.message, {
        issues: [{ path: ['credentialId'], message: 'credential does not exist' }],
      });
    }
    throw err;
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  const gate = await requireLlmConsole(request, 'llm:write');
  if (gate.error) return gate.error;

  const parsed = v1.llmResourceParamsSchema.safeParse({ id: (await params).id });
  if (!parsed.success) return v1ValidationError(parsed.error);

  const deleted = await providerStore().deleteById(parsed.data.id);
  if (!deleted) return v1Error('NOT_FOUND', `Provider ${parsed.data.id} not found`);

  await bumpCatalogAfterWrite(`provider ${parsed.data.id}`);
  return v1Success({ id: parsed.data.id, deleted: true as const });
}
