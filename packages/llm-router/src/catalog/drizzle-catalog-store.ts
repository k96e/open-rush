/**
 * {@link CatalogStore} 的 drizzle 实现（M3·T3.1）。
 *
 * 加载规则（A4 的判定依据，必须确定性）：
 *  1. 只收 `llm_models.enabled = true` **且** `llm_providers.enabled = true` 的行；
 *  2. 同 alias 的候选按 `priority` 升序排，并列按 `model.id` 升序；
 *  3. 排序在 SQL 里做完，`byAlias` 的数组直接就是排好的——`resolveRoute` 因此是 O(1)。
 *
 * 三条 SELECT 放进一个 **repeatable read** 事务里：默认的 read committed 下，
 * models 与 credentials 两条语句之间若有人删掉一个凭据，快照就会出现
 * 「provider 指着一个不在 map 里的 credentialId」的空洞，转发时静默变成不带认证
 * 的请求。快照是要被整份发布出去的，宁可多一次一致性开销。
 */
import {
  type DbClient,
  llmCatalogState,
  llmCredentials,
  llmModels,
  llmProviders,
} from '@open-rush/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { CatalogStateMissingError } from './bump-version.js';
import type { CatalogStore } from './catalog-store.js';
import type {
  CatalogAuthStyle,
  CatalogCredential,
  CatalogModel,
  CatalogProtocol,
  CatalogProvider,
  Snapshot,
} from './types.js';

type ProviderRow = typeof llmProviders.$inferSelect;
type ModelRow = typeof llmModels.$inferSelect;
type CredentialRow = typeof llmCredentials.$inferSelect;

function toProvider(row: ProviderRow): CatalogProvider {
  return {
    id: row.id,
    name: row.name,
    // DB 侧有 CHECK 约束兜底（`llm_providers_protocol_check`），这里只是把
    // varchar 收窄回联合类型。
    protocol: row.protocol as CatalogProtocol,
    baseUrl: row.baseUrl,
    credentialId: row.credentialId,
    defaultHeaders: row.defaultHeaders ?? {},
    timeoutMs: row.timeoutMs,
  };
}

function toModel(row: ModelRow): CatalogModel {
  return {
    id: row.id,
    alias: row.alias,
    providerId: row.providerId,
    upstreamModel: row.upstreamModel,
    priority: row.priority,
    displayName: row.displayName,
    maxOutputTokens: row.maxOutputTokens,
    priceInputPerMtok: row.priceInputPerMtok,
    priceOutputPerMtok: row.priceOutputPerMtok,
    priceCacheWritePerMtok: row.priceCacheWritePerMtok,
    priceCacheReadPerMtok: row.priceCacheReadPerMtok,
    priceReasoningPerMtok: row.priceReasoningPerMtok,
  };
}

function toCredential(row: CredentialRow): CatalogCredential {
  return {
    id: row.id,
    name: row.name,
    alg: row.alg,
    keyId: row.keyId,
    sealedValue: row.sealedValue,
    authStyle: row.authStyle as CatalogAuthStyle,
    authHeader: row.authHeader,
    version: row.version,
  };
}

export class DrizzleCatalogStore implements CatalogStore {
  constructor(private readonly db: DbClient) {}

  /** 只读一行一列。轮询兜底走的就是这条，不做任何附带查询。 */
  async readVersion(): Promise<number> {
    const [row] = await this.db
      .select({ version: llmCatalogState.version })
      .from(llmCatalogState)
      .where(eq(llmCatalogState.id, 1))
      .limit(1);
    if (!row) throw new CatalogStateMissingError();
    return row.version;
  }

  async loadSnapshot(version: number): Promise<Snapshot> {
    const { providerRows, modelRows, credentialRows } = await this.db.transaction(
      async (tx) => {
        const providerRows = await tx
          .select()
          .from(llmProviders)
          .where(eq(llmProviders.enabled, true));

        // provider 也必须 enabled——inner join 而不是先查 models 再过滤，
        // 这样「停用一个 provider」立刻让它名下所有 model 从索引里消失。
        const joined = await tx
          .select({ model: llmModels })
          .from(llmModels)
          .innerJoin(llmProviders, eq(llmModels.providerId, llmProviders.id))
          .where(and(eq(llmModels.enabled, true), eq(llmProviders.enabled, true)))
          .orderBy(asc(llmModels.alias), asc(llmModels.priority), asc(llmModels.id));

        const credentialIds = [
          ...new Set(
            providerRows
              .map((p) => p.credentialId)
              .filter((id): id is string => typeof id === 'string')
          ),
        ];
        const credentialRows = credentialIds.length
          ? await tx.select().from(llmCredentials).where(inArray(llmCredentials.id, credentialIds))
          : [];

        return { providerRows, modelRows: joined.map((r) => r.model), credentialRows };
      },
      { isolationLevel: 'repeatable read' }
    );

    const providers = new Map<string, CatalogProvider>();
    for (const row of providerRows) providers.set(row.id, toProvider(row));

    const credentials = new Map<string, CatalogCredential>();
    for (const row of credentialRows) credentials.set(row.id, toCredential(row));

    // SQL 已按 (alias, priority, id) 排好，顺序 push 即为候选顺序。
    const byAlias = new Map<string, CatalogModel[]>();
    for (const row of modelRows) {
      const model = toModel(row);
      const bucket = byAlias.get(model.alias);
      if (bucket) bucket.push(model);
      else byAlias.set(model.alias, [model]);
    }

    return { version, loadedAt: new Date(), byAlias, providers, credentials };
  }
}
