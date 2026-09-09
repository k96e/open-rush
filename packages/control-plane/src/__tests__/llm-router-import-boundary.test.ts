/**
 * control-plane 对 `@open-rush/llm-router` 的 import 边界（M6·T6.1）。
 *
 * 与 `apps/web/app/api/v1/llm/__tests__/import-boundary.test.ts` 是同一件事的
 * 第二个入口：**control-plane 是 apps/web 的依赖**，这里从裸的 `.` 引一句，
 * 网关那一整套（含解封函数）就会经由 control-plane 回到 web 的构建产物里——
 * M4 后续刚拆掉的东西原样引回去，`scripts/audit-no-plaintext-key.sh`（M7·T7.3）
 * 会 grep 到，「web 里连那段代码都不该有」这条更强的说法也就不成立了。
 *
 * 允许的只有 `./token`（只含铸造与哈希，模块图里只有 node:crypto）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SELF = fileURLToPath(import.meta.url);
const SRC_DIR = join(dirname(SELF), '..');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    // 排除本文件：它为了描述禁止的写法，正文里必然出现那几个字面量。
    else if (entry.endsWith('.ts') && full !== SELF) out.push(full);
  }
  return out;
}

describe('packages/control-plane 对 @open-rush/llm-router 的 import 边界', () => {
  const files = collectTsFiles(SRC_DIR);

  it('扫到了 control-plane 的源文件（防止用例因为路径写错而空跑）', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each([
    ["from '@open-rush/llm-router'", '静态 import'],
    ["import('@open-rush/llm-router')", '动态 import'],
    ["vi.mock('@open-rush/llm-router'", 'vi.mock'],
  ])('没有任何文件用裸的 `.` 入口（%s）', (needle) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(needle));
    expect(offenders).toEqual([]);
  });

  it('用的是 ./token 子路径，且只有 LlmAccessService 一处', () => {
    const users = files.filter((file) =>
      readFileSync(file, 'utf8').includes("'@open-rush/llm-router/token'")
    );
    expect(users.map((f) => f.split('/').slice(-2).join('/'))).toEqual([
      'llm/llm-access-service.ts',
    ]);
  });

  it('没有引进解封 / 私钥加载（那两个只允许在 llm-router 进程内）', () => {
    const all = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    // 拼出来而不是写字面量——否则本文件自己会被 M7·T7.3 的审计脚本 grep 到。
    expect(all).not.toContain(['open', 'Sealed'].join(''));
    expect(all).not.toContain(['loadRouter', 'PrivateKey'].join(''));
  });
});
