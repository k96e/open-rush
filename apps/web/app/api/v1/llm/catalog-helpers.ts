/**
 * `/api/v1/llm/providers/*` 与 `/api/v1/llm/models/*` 的共用件（M3·T3.4）。
 *
 * 三个职责：
 * - {@link requireLlmConsole} —— 认证 + scope + 「平台级资源只收 session」这条
 *   与 credentials 同一套的准入规则，四个路由文件共用一份，免得某个 method 漏掉一层。
 * - {@link bumpCatalogAfterWrite} —— 每个写操作之后 bump 目录版本位（D7）。
 *   漏调用 = router 副本永远看不到这次变更，是 `00-必读.md` §五③ 点名的坑。
 * - `providerToV1` / `modelToV1` —— **显式投影**。`v1Success<T>` 是无约束泛型、
 *   不跑 schema，所以线上形状只能靠手写投影守住（与 credentials 的
 *   `credentialToV1()` 同因同解）。
 */
import type { v1 } from '@open-rush/contracts';
import { getDbClient } from '@open-rush/db';
import {
  bumpCatalogVersion,
  DrizzleModelStore,
  DrizzleProviderStore,
  type ModelRow,
  type ProviderRow,
} from '@open-rush/llm-router';

import { v1Error } from '@/lib/api/v1-responses';
import { type AuthContext, authenticate, hasScope } from '@/lib/auth/unified-auth';

export type ConsoleAuth = { auth: AuthContext; error?: never } | { auth?: never; error: Response };

/**
 * 目录 API 的准入：session + scope。
 *
 * **平台级资源 → 拒绝 service token**，与 `/api/v1/llm/credentials` 同一条规则：
 * 目录决定「钱花到哪个上游、用哪把钥匙」，沙箱里的机器凭据不该能改，也不该能
 * 逐条读出 baseUrl 与凭据绑定关系。沙箱要的是转发本身，那条路走 llm-router 的
 * 短时令牌（D5/D6），不经过本 API。
 */
export async function requireLlmConsole(
  request: Request,
  scope: 'llm:read' | 'llm:write'
): Promise<ConsoleAuth> {
  const auth = await authenticate(request);
  if (!auth) return { error: v1Error('UNAUTHORIZED', 'Authentication required') };
  if (!hasScope(auth, scope)) return { error: v1Error('FORBIDDEN', `Missing scope ${scope}`) };
  if (auth.authType !== 'session') {
    return {
      error: v1Error('FORBIDDEN', 'The LLM catalog is platform-scoped and requires a session', {
        hint: 'Service tokens cannot read or manage the model catalog',
      }),
    };
  }
  return { auth };
}

/**
 * 写成功后 bump 目录版本位（D7）。
 *
 * 失败只记 error 日志，不回滚也不谎报 500：资源确实已经落库，返回失败会让客户端
 * 重试并撞上 409。代价是这条变更要等下一次目录写（或轮询到下一个版本）才会被副本
 * 看到，日志里把这个后果写清楚。
 */
export async function bumpCatalogAfterWrite(resource: string): Promise<void> {
  try {
    await bumpCatalogVersion(getDbClient());
  } catch (err) {
    console.error(
      `[llm/catalog] catalog version bump failed after writing ${resource}; ` +
        'router replicas will not pick this change up until the next catalog write',
      err
    );
  }
}

export function providerStore(): DrizzleProviderStore {
  return new DrizzleProviderStore(getDbClient());
}

export function modelStore(): DrizzleModelStore {
  return new DrizzleModelStore(getDbClient());
}

/** 行 → v1 线上形状。显式投影，绝不 spread。 */
export function providerToV1(row: ProviderRow): v1.LlmProvider {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as v1.LlmProvider['protocol'],
    baseUrl: row.baseUrl,
    credentialId: row.credentialId,
    defaultHeaders: row.defaultHeaders ?? {},
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function modelToV1(row: ModelRow): v1.LlmModel {
  return {
    id: row.id,
    alias: row.alias,
    providerId: row.providerId,
    upstreamModel: row.upstreamModel,
    priority: row.priority,
    enabled: row.enabled,
    displayName: row.displayName,
    maxOutputTokens: row.maxOutputTokens,
    priceInputPerMtok: row.priceInputPerMtok,
    priceOutputPerMtok: row.priceOutputPerMtok,
    priceCacheWritePerMtok: row.priceCacheWritePerMtok,
    priceCacheReadPerMtok: row.priceCacheReadPerMtok,
    priceReasoningPerMtok: row.priceReasoningPerMtok,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
