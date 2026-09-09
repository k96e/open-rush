/**
 * alias → 路由决策（M3·T3.3，F1 / A4）。
 *
 * 规则（A4 要求 100% 确定性）：
 *  1. 只看 `model.enabled && provider.enabled`（快照加载时已过滤）；
 *  2. `priority` 升序，并列按 `model.id` 升序（快照加载时已排序）；
 *  3. 无匹配 → {@link RouteError}，调用方看到 404。
 *
 * 快照已经排好序，这里是 O(1) 查表。
 *
 * ⚠️ {@link RouteError} **只带被请求的 alias**，不带目录里的其他模型名——
 * 404 错误体回显候选列表等于把整份目录送给任何持令牌的调用方（枚举泄露）。
 */
import type { ResolvedRoute, Snapshot } from './types.js';

export type RouteError = { readonly kind: 'model_not_found'; readonly alias: string };

/** 判别式：调用方用它区分成功与失败，不必 instanceof。 */
export function isRouteError(result: ResolvedRoute | RouteError): result is RouteError {
  return 'kind' in result;
}

export function resolveRoute(snapshot: Snapshot, alias: string): ResolvedRoute | RouteError {
  const candidates = snapshot.byAlias.get(alias);
  if (!candidates || candidates.length === 0) return { kind: 'model_not_found', alias };

  const model = candidates[0];
  const provider = snapshot.providers.get(model.providerId);
  // 正常加载路径下不会发生（模型是 inner join provider 出来的）；
  // 手工构造或将来加载逻辑变化时，宁可当作「没有这个模型」也不要抛。
  if (!provider) return { kind: 'model_not_found', alias };

  return {
    model,
    provider,
    credential: provider.credentialId
      ? (snapshot.credentials.get(provider.credentialId) ?? null)
      : null,
    // D2b：同名 → 字节级零改写；异名 → 只改 $.model 一个字段。
    mode: model.alias === model.upstreamModel ? 'passthrough' : 'rewrite-model',
  };
}
