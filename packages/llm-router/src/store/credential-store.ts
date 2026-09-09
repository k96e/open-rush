/**
 * `llm_credentials` 的数据访问层（M2·T2.3）。
 *
 * 密钥边界（specs/llm-router.md §密钥边界）在这里的体现：
 * - 本模块**只搬运密文**。`sealed_value` 由调用方在 apps/web 侧用公钥 seal 好
 *   再传进来，本层从不接触明文，也没有解封能力。
 * - {@link CredentialSummary} 是对外行的形状，**结构上不含 sealedValue**——
 *   路由层拿到的就是一个不可能回显密文的对象。密文只有 {@link findSealedById}
 *   会返回，那是 llm-router 转发路径专用的入口。
 * - 轮换 = 覆盖 `sealed_value` + `version++` + `rotated_at=now()`，
 *   **不保留历史密文**（A8：旧密钥不可从持久层还原）。
 */
import { type DbClient, llmCredentials, llmProviders } from '@open-rush/db';
import { and, count, desc, eq, lt, or, sql } from 'drizzle-orm';
import { clampLimit, decodeKeysetCursor, encodeKeysetCursor } from './cursor.js';
import { FK_VIOLATION, pgErrorCode, UNIQUE_VIOLATION } from './pg-errors.js';

type CredentialRow = typeof llmCredentials.$inferSelect;

/**
 * 凭据的领域形状。**故意不含 `sealedValue`**：任何想回显密文的实现都得先
 * 改这个类型，改动会立刻出现在 diff 里。
 */
export interface CredentialSummary {
  id: string;
  name: string;
  alg: string;
  keyId: string;
  authStyle: string;
  authHeader: string | null;
  version: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}

/** 新建凭据的入参。`sealedValue` 必须已经是密文。 */
export interface CreateCredentialInput {
  name: string;
  alg: string;
  keyId: string;
  sealedValue: string;
  authStyle: string;
  authHeader: string | null;
  createdBy: string | null;
}

export interface ListCredentialsOptions {
  /** 1..200，默认 50。 */
  limit?: number;
  /** 上一页返回的不透明游标，原样回传。 */
  cursor?: string;
}

export interface ListCredentialsResult {
  items: CredentialSummary[];
  nextCursor: string | null;
}

/** 名字撞车（`llm_credentials.name` 唯一）。路由层映射成 409。 */
export class CredentialNameConflictError extends Error {
  readonly name = 'CredentialNameConflictError';
  constructor(public readonly credentialName: string) {
    super(`credential '${credentialName}' already exists`);
  }
}

/** 仍被 provider 引用（FK `onDelete: 'restrict'`）。路由层映射成 409。 */
export class CredentialInUseError extends Error {
  readonly name = 'CredentialInUseError';
  constructor(
    public readonly credentialId: string,
    public readonly providerCount: number
  ) {
    super(`credential ${credentialId} is referenced by ${providerCount} provider(s)`);
  }
}

function toSummary(row: CredentialRow): CredentialSummary {
  return {
    id: row.id,
    name: row.name,
    alg: row.alg,
    keyId: row.keyId,
    authStyle: row.authStyle,
    authHeader: row.authHeader,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rotatedAt: row.rotatedAt,
  };
}

/**
 * 游标编解码复用 `cursor.ts`（M3 抽出，providers / models 共用同一套 keyset）。
 * 这里保留两个别名导出，M2 的调用点与单测不受影响。
 */
export const encodeCredentialCursor = encodeKeysetCursor;
export const decodeCredentialCursor = decodeKeysetCursor;

export class DrizzleCredentialStore {
  constructor(private readonly db: DbClient) {}

  /** 录入。名字冲突 → {@link CredentialNameConflictError}。 */
  async create(input: CreateCredentialInput): Promise<CredentialSummary> {
    try {
      const [row] = await this.db
        .insert(llmCredentials)
        .values({
          name: input.name,
          alg: input.alg,
          keyId: input.keyId,
          sealedValue: input.sealedValue,
          authStyle: input.authStyle,
          authHeader: input.authHeader,
          createdBy: input.createdBy,
        })
        .returning();
      return toSummary(row);
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) {
        throw new CredentialNameConflictError(input.name);
      }
      throw err;
    }
  }

  /** 列表，`(created_at DESC, id DESC)` keyset 分页。永不返回密文。 */
  async list(opts: ListCredentialsOptions = {}): Promise<ListCredentialsResult> {
    const limit = clampLimit(opts.limit);
    const cursor = decodeCredentialCursor(opts.cursor);

    // timestamptz 存微秒而 Date.toISOString() 只渲染毫秒，两侧都 truncate 到
    // 毫秒才能保证同毫秒的行不被游标漏掉（与 AgentDefinitionService 同因同解）。
    const where = cursor
      ? or(
          sql`date_trunc('milliseconds', ${llmCredentials.createdAt}) < ${cursor.createdAt}`,
          and(
            sql`date_trunc('milliseconds', ${llmCredentials.createdAt}) = ${cursor.createdAt}`,
            lt(llmCredentials.id, cursor.id)
          )
        )
      : undefined;

    const rows = await this.db
      .select()
      .from(llmCredentials)
      .where(where as never)
      .orderBy(
        sql`date_trunc('milliseconds', ${llmCredentials.createdAt}) DESC`,
        desc(llmCredentials.id)
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toSummary),
      nextCursor: hasMore && last ? encodeCredentialCursor(last.createdAt, last.id) : null,
    };
  }

  /** 单行查询，不含密文。找不到返回 null。 */
  async findById(id: string): Promise<CredentialSummary | null> {
    const [row] = await this.db
      .select()
      .from(llmCredentials)
      .where(eq(llmCredentials.id, id))
      .limit(1);
    return row ? toSummary(row) : null;
  }

  /**
   * **仅供 llm-router 转发路径**：连密文一起取出，由网关在栈上解封。
   * apps/web 不得调用——web 侧没有私钥，拿到密文也只是徒增泄漏面。
   */
  async findSealedById(
    id: string
  ): Promise<{ alg: string; keyId: string; sealedValue: string } | null> {
    const [row] = await this.db
      .select({
        alg: llmCredentials.alg,
        keyId: llmCredentials.keyId,
        sealedValue: llmCredentials.sealedValue,
      })
      .from(llmCredentials)
      .where(eq(llmCredentials.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * 轮换：覆盖密文、`version++`、`rotated_at = now()`。
   * **不写历史表**——旧密文在这一刻从持久层彻底消失（A8）。
   */
  async rotate(
    id: string,
    sealed: { alg: string; keyId: string; sealedValue: string }
  ): Promise<CredentialSummary | null> {
    const now = new Date();
    const [row] = await this.db
      .update(llmCredentials)
      .set({
        alg: sealed.alg,
        keyId: sealed.keyId,
        sealedValue: sealed.sealedValue,
        version: sql`${llmCredentials.version} + 1`,
        updatedAt: now,
        rotatedAt: now,
      })
      .where(eq(llmCredentials.id, id))
      .returning();
    return row ? toSummary(row) : null;
  }

  /**
   * 删除。仍被 provider 引用时抛 {@link CredentialInUseError}。
   *
   * 先查引用再删是为了给出「被几个 provider 引用」这样的可行动信息；
   * FK `onDelete: 'restrict'` 仍是最终防线（并发插入 provider 的窗口由它兜住）。
   */
  async deleteById(id: string): Promise<boolean> {
    const [{ referencing }] = await this.db
      .select({ referencing: count() })
      .from(llmProviders)
      .where(eq(llmProviders.credentialId, id));
    if (referencing > 0) throw new CredentialInUseError(id, referencing);

    try {
      const deleted = await this.db
        .delete(llmCredentials)
        .where(eq(llmCredentials.id, id))
        .returning({ id: llmCredentials.id });
      return deleted.length > 0;
    } catch (err) {
      // 查询与删除之间有人新建了引用——FK restrict 是最终防线。
      if (pgErrorCode(err) === FK_VIOLATION) throw new CredentialInUseError(id, 1);
      throw err;
    }
  }
}
