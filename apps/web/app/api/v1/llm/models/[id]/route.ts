/**
 * /api/v1/llm/models/:id
 *   - GET    — 单条
 *   - PATCH  — 部分更新（含启停、改优先级、改价目）
 *   - DELETE — 删除
 *
 * Auth scope：GET → `llm:read`，PATCH/DELETE → `llm:write`。平台级资源 → session-only。
 *
 * A7 的主路径就在这里：改完立刻 `bumpCatalogVersion`，NOTIFY 传到各副本，
 * 下一次路由决策就用新目录——不重启、不改代码。
 */
import { v1 } from '@open-rush/contracts';
import { CatalogConflictError, CatalogReferenceError } from '@open-rush/llm-router';

import { v1Error, v1Success, v1ValidationError } from '@/lib/api/v1-responses';

import {
  bumpCatalogAfterWrite,
  modelStore,
  modelToV1,
  requireLlmConsole,
} from '../../catalog-helpers';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const gate = await requireLlmConsole(request, 'llm:read');
  if (gate.error) return gate.error;

  const parsed = v1.llmResourceParamsSchema.safeParse({ id: (await params).id });
  if (!parsed.success) return v1ValidationError(parsed.error);

  const row = await modelStore().findById(parsed.data.id);
  if (!row) return v1Error('NOT_FOUND', `Model ${parsed.data.id} not found`);
  return v1Success(modelToV1(row));
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

  const parsed = v1.patchLlmModelRequestSchema.safeParse(body);
  if (!parsed.success) return v1ValidationError(parsed.error);

  try {
    const updated = await modelStore().patch(parsedParams.data.id, parsed.data);
    if (!updated) return v1Error('NOT_FOUND', `Model ${parsedParams.data.id} not found`);
    await bumpCatalogAfterWrite(`model ${updated.id}`);
    return v1Success(modelToV1(updated));
  } catch (err) {
    if (err instanceof CatalogConflictError) {
      return v1Error('VERSION_CONFLICT', err.message);
    }
    if (err instanceof CatalogReferenceError) {
      return v1Error('VALIDATION_ERROR', err.message, {
        issues: [{ path: ['providerId'], message: 'provider does not exist' }],
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

  const deleted = await modelStore().deleteById(parsed.data.id);
  if (!deleted) return v1Error('NOT_FOUND', `Model ${parsed.data.id} not found`);

  await bumpCatalogAfterWrite(`model ${parsed.data.id}`);
  return v1Success({ id: parsed.data.id, deleted: true as const });
}
