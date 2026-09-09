/**
 * /api/v1/llm/providers
 *   - POST — 新建供应商（协议 + baseUrl + 凭据引用）
 *   - GET  — 列表，可按 `enabled` 过滤，游标分页
 *
 * Auth scope（R5 §6.3）：POST → `llm:write`，GET → `llm:read`。
 * 平台级资源 → session-only，见 `catalog-helpers.ts#requireLlmConsole`。
 *
 * 目录热变更（D7）：写成功后必须 `bumpCatalogVersion`，否则 router 副本永远
 * 看不到这个 provider。
 */
import { v1 } from '@open-rush/contracts';
import { CatalogConflictError, CatalogReferenceError } from '@open-rush/llm-router';

import { v1Error, v1Paginated, v1Success, v1ValidationError } from '@/lib/api/v1-responses';

import {
  bumpCatalogAfterWrite,
  providerStore,
  providerToV1,
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

  const parsed = v1.createLlmProviderRequestSchema.safeParse(body);
  if (!parsed.success) return v1ValidationError(parsed.error);

  try {
    const created = await providerStore().create({
      name: parsed.data.name,
      protocol: parsed.data.protocol,
      baseUrl: parsed.data.baseUrl,
      credentialId: parsed.data.credentialId ?? null,
      defaultHeaders: parsed.data.defaultHeaders,
      timeoutMs: parsed.data.timeoutMs,
      enabled: parsed.data.enabled,
    });
    await bumpCatalogAfterWrite(`provider ${created.id}`);
    return v1Success(providerToV1(created), 201);
  } catch (err) {
    if (err instanceof CatalogConflictError) {
      return v1Error('VERSION_CONFLICT', `Provider '${parsed.data.name}' already exists`);
    }
    if (err instanceof CatalogReferenceError) {
      // 入参里指着的凭据不存在——是 body 的问题，不是「provider 不存在」。
      return v1Error('VALIDATION_ERROR', err.message, {
        issues: [{ path: ['credentialId'], message: 'credential does not exist' }],
      });
    }
    throw err;
  }
}

export async function GET(request: Request) {
  const gate = await requireLlmConsole(request, 'llm:read');
  if (gate.error) return gate.error;

  const url = new URL(request.url);
  const parsed = v1.listLlmProvidersQuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    enabled: url.searchParams.get('enabled') ?? undefined,
  });
  if (!parsed.success) return v1ValidationError(parsed.error);

  const { items, nextCursor } = await providerStore().list({
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
    enabled: parsed.data.enabled,
  });
  return v1Paginated(items.map(providerToV1), nextCursor);
}
