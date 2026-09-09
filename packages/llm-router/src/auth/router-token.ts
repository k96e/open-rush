/**
 * 调用方令牌：铸造、哈希、提取、认证（M4·T4.2，C5 §7.12，D5 / D6 / F7）。
 *
 * **令牌即归属（D6）**：认证的返回值 {@link Subject} 就是这次调用的授权与计费
 * 主体，全部来自 `llm_router_tokens` 这一行。绝不从请求头里读 runId / projectId
 * ——沙箱里有 bash，任何 header 都可以伪造；`x-claude-code-*` 只作分组提示。
 *
 * 明文只在签发时返回一次，库里只存 SHA-256 hex（复用 `service_tokens` 的成熟
 * 范式，但不复用表——生命周期与配额字段都不同）。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Subject, TokenStore } from './token-store.js';

export const ROUTER_TOKEN_PREFIX = 'rt_';

/** 明文形如 `rt_<43 chars base64url>`。 */
export function mintRouterToken(): { plaintext: string; tokenHash: string } {
  const plaintext = ROUTER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, tokenHash: hashRouterToken(plaintext) };
}

export function hashRouterToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * 从 `Authorization: Bearer …` 或 `x-api-key` 提取令牌。
 *
 * Claude Code 两种凭据变量都可能用（`ANTHROPIC_AUTH_TOKEN` → Authorization，
 * `ANTHROPIC_API_KEY` → x-api-key），两条都得认。
 *
 * 前缀不符一律返回 null：这样「误把供应商真 key 配到了网关上」会立刻 401，
 * 而不是被当成令牌去查库、在日志里留下一段真 key 的哈希。
 */
export function extractToken(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token.startsWith(ROUTER_TOKEN_PREFIX)) return token;
  }
  const apiKey = headers.get('x-api-key')?.trim();
  if (apiKey?.startsWith(ROUTER_TOKEN_PREFIX)) return apiKey;
  return null;
}

export interface TokenAuthenticatorOptions {
  /** 命中缓存的 TTL，默认 15s。设为 0 则每次查库（多约 1–2ms）。 */
  ttlMs?: number;
  /** 便于测试注入。 */
  now?: () => number;
  onTouchError?: (err: unknown) => void;
}

/**
 * 令牌认证 + 进程内短 TTL 缓存。
 *
 * ⚠️ **吊销生效上界 = 缓存 TTL（默认 15s）**。A9 的验收说明必须照实写成
 * 「≤15 秒内吊销」而不是「立即吊销」。需要更强保证就把 `ttlMs` 设为 0；
 * 控制面主动调 {@link invalidate} 可以把某一条立刻踢出缓存。
 */
export class TokenAuthenticator {
  private readonly cache = new Map<string, { subject: Subject; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: TokenStore,
    private readonly opts: TokenAuthenticatorOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  async authenticate(headers: Headers): Promise<Subject | null> {
    const raw = extractToken(headers);
    if (!raw) return null;
    const hash = hashRouterToken(raw);

    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > this.now()) return hit.subject;

    const subject = await this.store.findActiveByHash(hash);
    if (!subject) {
      // 刚被吊销 / 刚过期的那一条要从缓存里清掉，否则 TTL 内还能继续用。
      this.cache.delete(hash);
      return null;
    }

    if (this.ttlMs > 0) {
      this.cache.set(hash, { subject, expiresAt: this.now() + this.ttlMs });
    }
    // 与 unified-auth 同款：不等 last_used_at 写完，也不让它的失败影响这次调用。
    void this.store.touchLastUsed(subject.tokenId).catch((err) => this.opts.onTouchError?.(err));
    return subject;
  }

  /** 控制面吊销后调用，把该令牌立刻踢出缓存。 */
  invalidate(tokenId: string): void {
    for (const [hash, entry] of this.cache) {
      if (entry.subject.tokenId === tokenId) this.cache.delete(hash);
    }
  }

  /** 测试与 drain 用。 */
  clear(): void {
    this.cache.clear();
  }
}
