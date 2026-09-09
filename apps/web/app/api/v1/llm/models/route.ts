/**
 * /api/v1/llm/models
 *   - POST — 新建目录项（alias → upstreamModel + 价目）
 *   - GET  — 列表，可按 `providerId` / `enabled` 过滤，游标分页
 *
 * Auth scope（R5 §6.3）：POST → `llm:write`，GET → `llm:read`。平台级资源 → session-only。
 *
 * D2b：`alias === upstreamModel` 时走 passthrough（字节级零改写），异名时只改
 * `$.model` 一个字段。目录里怎么填直接决定这条，路由本身不做任何劝导。
 *
 * 目录热变更（D7）：写成功后必须 `bumpCatalogVersion`。
 */
import { v1 } from '@open-rush/contracts';
import { CatalogConflictError, CatalogReferenceError } from '@open-rush/llm-router';

import { v1Error, v1Paginated, v1Success, v1ValidationError } from '@/lib/api/v1-responses';

import {
  bumpCatalogAfterWrite,
  modelStore,
  modelToV1,
  requireLlmConsole,
} from '../catalog-helpers';

export async function POST(request: Request) {
  const gate = await requireLlmConsole(request, 'llm:write');
  if (gate.error) return gate.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return v1Error('VALIDATION_ERROR', 'Invalid JSON body');
  }

  const parsed = v1.createLlmModelRequestSchema.safeParse(body);
  if (!parsed.success) return v1ValidationError(parsed.error);

  try {
    const created = await modelStore().create({
      alias: parsed.data.alias,
      providerId: parsed.data.providerId,
      upstreamModel: parsed.data.upstreamModel,
      priority: parsed.data.priority,
      enabled: parsed.data.enabled,
      displayName: parsed.data.displayName ?? null,
      maxOutputTokens: parsed.data.maxOutputTokens ?? null,
      priceInputPerMtok: parsed.data.priceInputPerMtok,
      priceOutputPerMtok: parsed.data.priceOutputPerMtok,
      priceCacheWritePerMtok: parsed.data.priceCacheWritePerMtok,
      priceCacheReadPerMtok: parsed.data.priceCacheReadPerMtok,
      priceReasoningPerMtok: parsed.data.priceReasoningPerMtok,
    });
    await bumpCatalogAfterWrite(`model ${created.id}`);
    return v1Success(modelToV1(created), 201);
  } catch (err) {
    if (err instanceof CatalogConflictError) {
      return v1Error('VERSION_CONFLICT', err.message, {
        hint: 'Alias must be unique per provider; use PATCH to change the existing entry',
      });
    }
    if (err instanceof CatalogReferenceError) {
      return v1Error('VALIDATION_ERROR', err.message, {
        issues: [{ path: ['providerId'], message: 'provider does not exist' }],
      });
    }
    throw err;
  }
}

export async function GET(request: Request) {
  const gate = await requireLlmConsole(request, 'llm:read');
  if (gate.error) return gate.error;

  const url = new URL(request.url);
  const parsed = v1.listLlmModelsQuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    providerId: url.searchParams.get('providerId') ?? undefined,
    enabled: url.searchParams.get('enabled') ?? undefined,
  });
  if (!parsed.success) return v1ValidationError(parsed.error);

  const { items, nextCursor } = await modelStore().list({
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
    providerId: parsed.data.providerId,
    enabled: parsed.data.enabled,
  });
  return v1Paginated(items.map(modelToV1), nextCursor);
}
