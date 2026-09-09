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

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 50;
  return Math.min(Math.floor(raw), 200);
}

/**
 * 列表游标 = base64url("<createdAtISO>|<id>")，对客户端不透明。
 * 与 `AgentDefinitionService` 同款：`(created_at, id)` keyset，`id` 做并列
 * 时的 tiebreaker，避免同毫秒创建的两行互相顶掉。
 */
export function encodeCredentialCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** 解析失败一律返回 null（回落到「第一页」），不因为一个装饰性字段报错。 */
export function decodeCredentialCursor(cursor: string | undefined): {
  createdAt: Date;
  id: string;
} | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep < 0) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * 取 PostgreSQL 的 SQLSTATE。
 *
 * drizzle 0.45 把驱动错误包进 `DrizzleQueryError`，真正带 `code` 的是
 * `cause`（PGlite 与 postgres.js 都是如此），所以要顺着 cause 链找。
 */
function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 23505 = unique_violation */
const UNIQUE_VIOLATION = '23505';
/** 23503 = foreign_key_violation */
const FK_VIOLATION = '23503';

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
   * **仅供 llm-router 转发路径**：连密文一起取出，交给 `openSealed` 在栈上解封。
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
