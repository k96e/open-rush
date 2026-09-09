/**
 * 目录快照的领域类型（M3·T3.1）。
 *
 * 一致性模型见 `catalog-cache.ts`：DB 是唯一真相，进程内持有**不可变**快照。
 * 这里的所有类型都用 `readonly` / `ReadonlyMap` 标注——快照一旦发布就不再修改，
 * 刷新是整体替换而不是就地改字段（在途请求继续用取路由时的那一份，
 * 不会中途换供应商）。
 *
 * ⚠️ {@link CatalogCredential.sealedValue} 是**密文**。它只在 llm-router 进程内
 * 的快照里出现，解封发生在转发那一刻（M4·T4.3）。apps/web 侧既没有私钥也没有
 * 解封调用点，拿到密文也还原不出明文。
 */

/** 上游协议族。与 `v1.llmProtocolSchema` 同一套值，此处不 import contracts 以免库层耦合到 zod。 */
export type CatalogProtocol = 'anthropic' | 'openai';

/** 上游认证方式。与 `v1.llmAuthStyleSchema` 对齐。 */
export type CatalogAuthStyle = 'bearer' | 'x-api-key' | 'header';

/** 同协议下的两种路由模式。跨协议的 `translate` 由 M4·T4.7 处理，不在快照里判定。 */
export type CatalogRouteMode = 'passthrough' | 'rewrite-model';

export interface CatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly protocol: CatalogProtocol;
  /** 不含尾斜杠。 */
  readonly baseUrl: string;
  readonly credentialId: string | null;
  readonly defaultHeaders: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * 目录里的一个模型条目。
 *
 * 价格列是 PostgreSQL `numeric`，drizzle 映射成 **string**——这里原样保留字符串，
 * 由 M5 的 `computeCostUsd` 用十进制运算，避免 float 误差。
 */
export interface CatalogModel {
  readonly id: string;
  readonly alias: string;
  readonly providerId: string;
  readonly upstreamModel: string;
  readonly priority: number;
  readonly displayName: string | null;
  readonly maxOutputTokens: number | null;
  readonly priceInputPerMtok: string;
  readonly priceOutputPerMtok: string;
  readonly priceCacheWritePerMtok: string;
  readonly priceCacheReadPerMtok: string;
  readonly priceReasoningPerMtok: string;
}

/** 凭据的密文信封 + 认证方式。**只在 llm-router 进程内使用**。 */
export interface CatalogCredential {
  readonly id: string;
  readonly name: string;
  readonly alg: string;
  readonly keyId: string;
  /** base64 密文。解封只发生在转发路径上。 */
  readonly sealedValue: string;
  readonly authStyle: CatalogAuthStyle;
  readonly authHeader: string | null;
  readonly version: number;
}

/**
 * 一份不可变目录快照。
 *
 * `byAlias` 的候选数组**在加载时就按 A4 规则排好序**（priority 升序、并列按 id
 * 升序），因此 `resolveRoute` 是 O(1) 查表而不是每次排序。
 */
export interface Snapshot {
  /** 加载这份快照时读到的 `llm_catalog_state.version`。 */
  readonly version: number;
  readonly loadedAt: Date;
  /** alias → 已排序的候选模型（只含 enabled model + enabled provider）。 */
  readonly byAlias: ReadonlyMap<string, readonly CatalogModel[]>;
  readonly providers: ReadonlyMap<string, CatalogProvider>;
  readonly credentials: ReadonlyMap<string, CatalogCredential>;
}

/** 路由决策。`credential` 为 null 表示该 provider 未绑定凭据（转发时不带认证头）。 */
export interface ResolvedRoute {
  readonly model: CatalogModel;
  readonly provider: CatalogProvider;
  readonly credential: CatalogCredential | null;
  readonly mode: CatalogRouteMode;
}
