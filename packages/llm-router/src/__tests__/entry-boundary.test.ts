/**
 * 入口边界的回归测试（A11 的打包面）。
 *
 * 结论要守住的是：**apps/web 引到的两个子路径入口，产物里没有解封代码**。
 * 这件事只能对 `dist` 断言——源码层面 `sealing.ts` 当然不含它，真正的风险在
 * 打包器：只要 tsup 把共享模块提到一个 chunk 里，解封代码就会随 `./store`
 * 一起回到 web 的产物中（`tsup.config.ts` 因此关掉了 splitting）。
 *
 * 这份测试跑在 `pnpm test` 里，而 turbo 的 `test` 依赖 `build`，所以 `dist`
 * 一定是当前源码构建出来的。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../dist');

/** 解封函数的名字，拼出来而不是写字面量——否则本文件自己会被审计脚本 grep 到。 */
const UNSEAL = ['open', 'Sealed'].join('');

const read = (file: string): string => readFileSync(join(DIST, file), 'utf8');

describe('子路径入口的产物边界', () => {
  it.each([
    'sealing.js',
    'sealing.cjs',
    'store.js',
    'store.cjs',
    'token.js',
    'token.cjs',
  ])('%s 的字节里没有解封函数', (file) => {
    const content = read(file);
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toContain(UNSEAL);
  });

  it.each([
    'sealing.js',
    'store.js',
    'token.js',
  ])('%s 不引用任何共享 chunk（splitting 必须关着）', (file) => {
    // 一旦 splitting 被打开，这里会出现 `from "./chunk-XXXX.js"`，
    // 而那个 chunk 是与 `.` 入口共用的——解封代码就绕回来了。
    expect(read(file)).not.toMatch(/from ["']\.\/chunk-/);
  });

  it('sealing 入口导出封装侧，且**没有**解封函数', async () => {
    const mod = await import('../sealing.js');
    expect(typeof mod.seal).toBe('function');
    expect(typeof mod.computeKeyId).toBe('function');
    expect(UNSEAL in mod).toBe(false);
  });

  it('store 入口导出控制台需要的 store，且不碰 node:crypto', async () => {
    const mod = await import('../store.js');
    expect(typeof mod.DrizzleCredentialStore).toBe('function');
    expect(typeof mod.DrizzleProviderStore).toBe('function');
    expect(typeof mod.DrizzleModelStore).toBe('function');
    expect(typeof mod.bumpCatalogVersion).toBe('function');
    expect(read('store.js')).not.toContain('node:crypto');
  });

  it('token 入口只有铸造与哈希——没有转发、没有目录、没有 store', async () => {
    const mod = await import('../token.js');
    expect(Object.keys(mod).sort()).toEqual([
      'ROUTER_TOKEN_PREFIX',
      'hashRouterToken',
      'mintRouterToken',
    ]);
    // control-plane 是 apps/web 的依赖：从 `.` 引会把网关那一整套经由
    // control-plane 传递回 web，M4 后续刚拆掉的东西就白拆了。
    const content = read('token.js');
    expect(content).not.toContain('DrizzleCatalogStore');
    expect(content).not.toContain('drizzle-orm');
    expect(content).not.toContain('forward');
  });

  it('token 入口铸出来的令牌能被 `.` 入口的哈希认出来（两个入口没有各自一份实现）', async () => {
    const { mintRouterToken } = await import('../token.js');
    const { hashRouterToken } = await import('../index.js');
    const { plaintext, tokenHash } = mintRouterToken();
    expect(plaintext.startsWith('rt_')).toBe(true);
    expect(hashRouterToken(plaintext)).toBe(tokenHash);
  });

  it('`.` 入口仍然带着解封函数（网关要用）', () => {
    expect(read('index.js')).toContain(UNSEAL);
  });

  it('封装与解封仍然互通（拆文件没有拆坏密码学）', async () => {
    const { seal, generateRouterKeyPair } = await import('../sealing.js');
    const { openSealed } = await import('../crypto/open-sealed.js');
    const keys = generateRouterKeyPair();
    const envelope = seal(keys.publicKeyPem, 'sk-round-trip-你好-🌏');
    expect(openSealed(keys.privateKeyPem, envelope)).toBe('sk-round-trip-你好-🌏');
  });
});
