/**
 * `llm_models` 的数据访问层（M3·T3.4）。
 *
 * 与 `provider-store.ts` 同一形状。价格列是 `numeric`——drizzle 双向都用
 * **string**，本层原样搬运，不做 Number() 转换（会丢精度）。
 *
 * ⚠️ 本层不 bump 目录版本，理由同 `provider-store.ts`。
 */
import { type DbClient, llmModels } from '@open-rush/db';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { CatalogConflictError, CatalogReferenceError } from './catalog-errors.js';
import { clampLimit, decodeKeysetCursor, encodeKeysetCursor } from './cursor.js';
import { FK_VIOLATION, pgErrorCode, UNIQUE_VIOLATION } from './pg-errors.js';

export type ModelRow = typeof llmModels.$inferSelect;

export interface CreateModelInput {
  alias: string;
  providerId: string;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
  displayName: string | null;
  maxOutputTokens: number | null;
  priceInputPerMtok: string;
  priceOutputPerMtok: string;
  priceCacheWritePerMtok: string;
  priceCacheReadPerMtok: string;
  priceReasoningPerMtok: string;
}

export type PatchModelInput = Partial<CreateModelInput>;

export interface ListModelsOptions {
  limit?: number;
  cursor?: string;
  providerId?: string;
  enabled?: boolean;
}

export interface ListModelsResult {
  items: ModelRow[];
  nextCursor: string | null;
}

export class DrizzleModelStore {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateModelInput): Promise<ModelRow> {
    try {
      const [row] = await this.db.insert(llmModels).values(input).returning();
      return row;
    } catch (err) {
      throw translateModelWriteError(err, input.alias, input.providerId);
    }
  }

  /** `(created_at DESC, id DESC)` keyset 分页，可按 providerId / enabled 过滤。 */
  async list(opts: ListModelsOptions = {}): Promise<ListModelsResult> {
    const limit = clampLimit(opts.limit);
    const cursor = decodeKeysetCursor(opts.cursor);

    const keyset = cursor
      ? or(
          sql`date_trunc('milliseconds', ${llmModels.createdAt}) < ${cursor.createdAt}`,
          and(
            sql`date_trunc('milliseconds', ${llmModels.createdAt}) = ${cursor.createdAt}`,
            lt(llmModels.id, cursor.id)
          )
        )
      : undefined;

    const filters = [
      opts.providerId === undefined ? undefined : eq(llmModels.providerId, opts.providerId),
      opts.enabled === undefined ? undefined : eq(llmModels.enabled, opts.enabled),
      keyset,
    ].filter((f) => f !== undefined);
    const where = filters.length ? and(...filters) : undefined;

    const rows = await this.db
      .select()
      .from(llmModels)
      .where(where as never)
      .orderBy(sql`date_trunc('milliseconds', ${llmModels.createdAt}) DESC`, desc(llmModels.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: hasMore && last ? encodeKeysetCursor(last.createdAt, last.id) : null,
    };
  }

  async findById(id: string): Promise<ModelRow | null> {
    const [row] = await this.db.select().from(llmModels).where(eq(llmModels.id, id)).limit(1);
    return row ?? null;
  }

  async patch(id: string, patch: PatchModelInput): Promise<ModelRow | null> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) values[key] = value;
    }

    try {
      const [row] = await this.db
        .update(llmModels)
        .set(values)
        .where(eq(llmModels.id, id))
        .returning();
      return row ?? null;
    } catch (err) {
      throw translateModelWriteError(err, patch.alias ?? id, patch.providerId ?? '(unknown)');
    }
  }

  async deleteById(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(llmModels)
      .where(eq(llmModels.id, id))
      .returning({ id: llmModels.id });
    return deleted.length > 0;
  }
}

/**
 * - 23505 → `(alias, provider_id)` 撞车（同一个 provider 下同名 alias）
 * - 23503 → `provider_id` 指向不存在的 provider
 */
function translateModelWriteError(err: unknown, alias: string, providerId: string): unknown {
  const code = pgErrorCode(err);
  if (code === UNIQUE_VIOLATION) {
    return new CatalogConflictError(
      `model alias '${alias}' already exists for provider ${providerId}`
    );
  }
  if (code === FK_VIOLATION) {
    return new CatalogReferenceError('providerId', providerId);
  }
  return err;
}
