/**
 * 令牌的**铸造与哈希**（M4·T4.2 的两个纯函数，M6·T6.1 拆出）。
 *
 * 单独一个文件，是为了给 `@open-rush/llm-router/token` 子路径入口一个
 * **只含 node:crypto** 的模块图：`packages/control-plane` 签发 per-run 令牌时
 * 只需要这两个函数，不该把网关那一整套转发 / 认证 / 解封代码经由 control-plane
 * 传递回 apps/web（见 `docs/plans/llm-router/01-进度.md` 的「决策变更记录」）。
 *
 * 明文只在签发时返回一次，库里只存 SHA-256 hex——复用 `service_tokens` 的成熟
 * 范式，但不复用表（D5）。
 */
import { createHash, randomBytes } from 'node:crypto';

export const ROUTER_TOKEN_PREFIX = 'rt_';

/** 明文形如 `rt_<43 chars base64url>`。 */
export function mintRouterToken(): { plaintext: string; tokenHash: string } {
  const plaintext = ROUTER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, tokenHash: hashRouterToken(plaintext) };
}

export function hashRouterToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
