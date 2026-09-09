import { describe, expect, it, vi } from 'vitest';
import {
  extractToken,
  hashRouterToken,
  mintRouterToken,
  ROUTER_TOKEN_PREFIX,
  TokenAuthenticator,
} from '../router-token.js';
import { isAliasAllowed, type Subject, type TokenStore } from '../token-store.js';

const subject = (over: Partial<Subject> = {}): Subject => ({
  tokenId: 'tok-1',
  subjectType: 'run',
  runId: 'run-1',
  agentId: null,
  projectId: 'proj-1',
  ownerUserId: null,
  allowedModelAliases: [],
  maxCostUsd: null,
  maxRequestsPerMinute: null,
  ...over,
});

class FakeStore implements TokenStore {
  findActiveByHash = vi.fn(async (_hash: string): Promise<Subject | null> => subject());
  touchLastUsed = vi.fn(async (_id: string): Promise<void> => {});
}

describe('mintRouterToken', () => {
  it('明文带 rt_ 前缀，哈希与明文对应', () => {
    const { plaintext, tokenHash } = mintRouterToken();
    expect(plaintext.startsWith(ROUTER_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashRouterToken(plaintext));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('两次铸造不重复', () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintRouterToken().plaintext));
    expect(seen.size).toBe(50);
  });

  it('库里存的哈希还原不出明文（长度固定、与明文不含公共子串）', () => {
    const { plaintext, tokenHash } = mintRouterToken();
    expect(tokenHash).not.toContain(plaintext.slice(ROUTER_TOKEN_PREFIX.length, 16));
  });
});

describe('extractToken', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it('从 Authorization: Bearer 提取', () => {
    expect(extractToken(h({ authorization: 'Bearer rt_abc' }))).toBe('rt_abc');
  });

  it('从 x-api-key 提取', () => {
    expect(extractToken(h({ 'x-api-key': 'rt_abc' }))).toBe('rt_abc');
  });

  it('两个头都在时以 Authorization 优先', () => {
    expect(extractToken(h({ authorization: 'Bearer rt_a', 'x-api-key': 'rt_b' }))).toBe('rt_a');
  });

  it('Authorization 前缀不符时回落到 x-api-key', () => {
    expect(extractToken(h({ authorization: 'Bearer sk-real', 'x-api-key': 'rt_b' }))).toBe('rt_b');
  });

  it.each([
    ['无任何头', {}],
    ['非 rt_ 前缀的 Bearer（例如误配了供应商真 key）', { authorization: 'Bearer sk-ant-xxx' }],
    ['非 rt_ 前缀的 x-api-key', { 'x-api-key': 'sk-ant-xxx' }],
    ['Basic 认证', { authorization: 'Basic cnQ6cnQ=' }],
    ['空 Bearer', { authorization: 'Bearer ' }],
  ])('%s → null', (_label, init) => {
    expect(extractToken(h(init as Record<string, string>))).toBeNull();
  });

  it('两侧空白被裁掉', () => {
    expect(extractToken(h({ authorization: 'Bearer   rt_abc  ' }))).toBe('rt_abc');
    expect(extractToken(h({ 'x-api-key': ' rt_abc ' }))).toBe('rt_abc');
  });
});

describe('isAliasAllowed', () => {
  it('空白名单放行一切', () => {
    expect(isAliasAllowed(subject({ allowedModelAliases: [] }), 'anything')).toBe(true);
  });

  it('命中白名单放行，未命中拒绝', () => {
    const s = subject({ allowedModelAliases: ['a', 'b'] });
    expect(isAliasAllowed(s, 'a')).toBe(true);
    expect(isAliasAllowed(s, 'c')).toBe(false);
  });
});

describe('TokenAuthenticator', () => {
  const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

  it('无令牌头 → null，且不打 DB', async () => {
    const store = new FakeStore();
    const auth = new TokenAuthenticator(store);
    expect(await auth.authenticate(new Headers())).toBeNull();
    expect(store.findActiveByHash).not.toHaveBeenCalled();
  });

  it('非 rt_ 前缀 → null，且不打 DB（不拿真 key 去查库）', async () => {
    const store = new FakeStore();
    const auth = new TokenAuthenticator(store);
    expect(await auth.authenticate(bearer('sk-ant-real-key'))).toBeNull();
    expect(store.findActiveByHash).not.toHaveBeenCalled();
  });

  it('查库用的是哈希而不是明文', async () => {
    const store = new FakeStore();
    await new TokenAuthenticator(store).authenticate(bearer('rt_plain'));
    expect(store.findActiveByHash).toHaveBeenCalledWith(hashRouterToken('rt_plain'));
  });

  it('已吊销 / 已过期（store 返回 null）→ null', async () => {
    const store = new FakeStore();
    store.findActiveByHash.mockResolvedValue(null);
    expect(await new TokenAuthenticator(store).authenticate(bearer('rt_x'))).toBeNull();
  });

  it('缓存命中不打 DB', async () => {
    const store = new FakeStore();
    const auth = new TokenAuthenticator(store, { ttlMs: 1000 });
    await auth.authenticate(bearer('rt_x'));
    await auth.authenticate(bearer('rt_x'));
    await auth.authenticate(bearer('rt_x'));
    expect(store.findActiveByHash).toHaveBeenCalledTimes(1);
  });

  it('TTL 过后重新查库', async () => {
    const store = new FakeStore();
    let now = 1_000_000;
    const auth = new TokenAuthenticator(store, { ttlMs: 15_000, now: () => now });
    await auth.authenticate(bearer('rt_x'));
    now += 15_001;
    await auth.authenticate(bearer('rt_x'));
    expect(store.findActiveByHash).toHaveBeenCalledTimes(2);
  });

  it('ttlMs=0 时每次都查库（硬吊销）', async () => {
    const store = new FakeStore();
    const auth = new TokenAuthenticator(store, { ttlMs: 0 });
    await auth.authenticate(bearer('rt_x'));
    await auth.authenticate(bearer('rt_x'));
    expect(store.findActiveByHash).toHaveBeenCalledTimes(2);
  });

  it('invalidate() 立刻踢出缓存，下一次重新查库', async () => {
    const store = new FakeStore();
    const auth = new TokenAuthenticator(store, { ttlMs: 60_000 });
    await auth.authenticate(bearer('rt_x'));
    auth.invalidate('tok-1');
    store.findActiveByHash.mockResolvedValue(null);
    expect(await auth.authenticate(bearer('rt_x'))).toBeNull();
    expect(store.findActiveByHash).toHaveBeenCalledTimes(2);
  });

  it('invalidate() 不影响其他令牌的缓存', async () => {
    const store = new FakeStore();
    store.findActiveByHash.mockImplementation(async (hash: string) =>
      subject({ tokenId: hash === hashRouterToken('rt_a') ? 'tok-a' : 'tok-b' })
    );
    const auth = new TokenAuthenticator(store, { ttlMs: 60_000 });
    await auth.authenticate(bearer('rt_a'));
    await auth.authenticate(bearer('rt_b'));
    auth.invalidate('tok-a');
    await auth.authenticate(bearer('rt_b'));
    expect(store.findActiveByHash).toHaveBeenCalledTimes(2);
  });

  it('store 返回 null 时把旧缓存清掉（吊销后不因缓存续命）', async () => {
    const store = new FakeStore();
    const auth = new TokenAuthenticator(store, { ttlMs: 0 });
    await auth.authenticate(bearer('rt_x'));
    store.findActiveByHash.mockResolvedValue(null);
    expect(await auth.authenticate(bearer('rt_x'))).toBeNull();
  });

  it('touchLastUsed 是 fire-and-forget，失败不影响认证结果', async () => {
    const store = new FakeStore();
    store.touchLastUsed.mockRejectedValue(new Error('db down'));
    const onTouchError = vi.fn();
    const auth = new TokenAuthenticator(store, { onTouchError });
    await expect(auth.authenticate(bearer('rt_x'))).resolves.toMatchObject({ tokenId: 'tok-1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(onTouchError).toHaveBeenCalledTimes(1);
  });

  it('认证成功返回的归属来自 store，不来自任何请求头', async () => {
    const store = new FakeStore();
    store.findActiveByHash.mockResolvedValue(
      subject({ runId: 'real-run', projectId: 'real-proj' })
    );
    const auth = new TokenAuthenticator(store);
    const headers = new Headers({
      authorization: 'Bearer rt_x',
      'x-claude-code-session-id': 'forged-session',
    });
    // 伪造的 header 不参与归属：结果里只有令牌上的 run/project。
    await expect(auth.authenticate(headers)).resolves.toEqual(
      subject({ runId: 'real-run', projectId: 'real-proj' })
    );
  });
});
