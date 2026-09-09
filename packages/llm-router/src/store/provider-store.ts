/**
 * `llm_providers` 的数据访问层（M3·T3.4）。
 *
 * 与 `credential-store.ts` 同一形状：数据访问放库层，路由只做鉴权 + 投影
 * （见 `01-进度.md` 2026-09-09「M2 实施位置」一条）。这样「唯一约束 → 409」
 * 「外键 → 400」这类分支能在 PGlite 上真跑，而不是靠 mock 链断言。
 *
 * ⚠️ 本层**不 bump 目录版本**。`bumpCatalogVersion` 由路由层在写成功后单独调用：
 * 它必须在写事务提交之后发 NOTIFY，塞进 store 里就没法保证这个顺序了。
 */
import { type DbClient, llmProviders } from '@open-rush/db';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { CatalogConflictError, CatalogReferenceError } from './catalog-errors.js';
import { clampLimit, decodeKeysetCursor, encodeKeysetCursor } from './cursor.js';
import { FK_VIOLATION, pgErrorCode, UNIQUE_VIOLATION } from './pg-errors.js';

export type ProviderRow = typeof llmProviders.$inferSelect;

export interface CreateProviderInput {
  name: string;
  protocol: string;
  baseUrl: string;
  credentialId: string | null;
  defaultHeaders: Record<string, string>;
  timeoutMs: number;
  enabled: boolean;
}

/** PATCH 入参。`undefined` = 不动这个字段；`credentialId: null` = 显式解绑。 */
export type PatchProviderInput = Partial<CreateProviderInput>;

export interface ListProvidersOptions {
  limit?: number;
  cursor?: string;
  enabled?: boolean;
}

export interface ListProvidersResult {
  items: ProviderRow[];
  nextCursor: string | null;
}

/** baseUrl 归一：去掉尾斜杠（R4 §5.3 要求「不含尾斜杠」），转发时才不会拼出 `//v1/messages`。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export class DrizzleProviderStore {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateProviderInput): Promise<ProviderRow> {
    try {
      const [row] = await this.db
        .insert(llmProviders)
        .values({
          name: input.name,
          protocol: input.protocol,
          baseUrl: normalizeBaseUrl(input.baseUrl),
          credentialId: input.credentialId,
          defaultHeaders: input.defaultHeaders,
          timeoutMs: input.timeoutMs,
          enabled: input.enabled,
        })
        .returning();
      return row;
    } catch (err) {
      throw translateProviderWriteError(err, input.name, input.credentialId ?? null);
    }
  }

  /** `(created_at DESC, id DESC)` keyset 分页，可按 enabled 过滤。 */
  async list(opts: ListProvidersOptions = {}): Promise<ListProvidersResult> {
    const limit = clampLimit(opts.limit);
    const cursor = decodeKeysetCursor(opts.cursor);

    // timestamptz 存微秒而 Date.toISOString() 只渲染毫秒，两侧都 truncate 到毫秒
    // 才能保证同毫秒的行不被游标漏掉（与 credential-store 同因同解）。
    const keyset = cursor
      ? or(
          sql`date_trunc('milliseconds', ${llmProviders.createdAt}) < ${cursor.createdAt}`,
          and(
            sql`date_trunc('milliseconds', ${llmProviders.createdAt}) = ${cursor.createdAt}`,
            lt(llmProviders.id, cursor.id)
          )
        )
      : undefined;
    const filter = opts.enabled === undefined ? undefined : eq(llmProviders.enabled, opts.enabled);
    const where = keyset && filter ? and(keyset, filter) : (keyset ?? filter);

    const rows = await this.db
      .select()
      .from(llmProviders)
      .where(where as never)
      .orderBy(
        sql`date_trunc('milliseconds', ${llmProviders.createdAt}) DESC`,
        desc(llmProviders.id)
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: hasMore && last ? encodeKeysetCursor(last.createdAt, last.id) : null,
    };
  }

  async findById(id: string): Promise<ProviderRow | null> {
    const [row] = await this.db.select().from(llmProviders).where(eq(llmProviders.id, id)).limit(1);
    return row ?? null;
  }

  /** 部分更新。找不到返回 null（路由层映射成 404）。 */
  async patch(id: string, patch: PatchProviderInput): Promise<ProviderRow | null> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.protocol !== undefined) values.protocol = patch.protocol;
    if (patch.baseUrl !== undefined) values.baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (patch.credentialId !== undefined) values.credentialId = patch.credentialId;
    if (patch.defaultHeaders !== undefined) values.defaultHeaders = patch.defaultHeaders;
    if (patch.timeoutMs !== undefined) values.timeoutMs = patch.timeoutMs;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;

    try {
      const [row] = await this.db
        .update(llmProviders)
        .set(values)
        .where(eq(llmProviders.id, id))
        .returning();
      return row ?? null;
    } catch (err) {
      throw translateProviderWriteError(err, patch.name ?? id, patch.credentialId ?? null);
    }
  }

  /**
   * 删除。`llm_models.provider_id` 是 `ON DELETE CASCADE`，所以删 provider
   * **会连带删掉它名下的所有 model**——这是既定的 schema 决策（R4 §5.4），
   * 路由层要在响应里把这个后果说清楚。
   */
  async deleteById(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(llmProviders)
      .where(eq(llmProviders.id, id))
      .returning({ id: llmProviders.id });
    return deleted.length > 0;
  }
}

/**
 * 把 SQLSTATE 翻成领域错误。
 * - 23505 → 名字撞车（`llm_providers_name_unique`）
 * - 23503 → `credential_id` 指向不存在的凭据
 */
function translateProviderWriteError(
  err: unknown,
  name: string,
  credentialId: string | null
): unknown {
  const code = pgErrorCode(err);
  if (code === UNIQUE_VIOLATION) {
    return new CatalogConflictError(`provider '${name}' already exists`);
  }
  if (code === FK_VIOLATION) {
    return new CatalogReferenceError('credentialId', credentialId ?? '(unknown)');
  }
  return err;
}
