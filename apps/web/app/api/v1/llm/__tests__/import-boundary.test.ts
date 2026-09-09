/**
 * 源码侧的入口边界（A11 的打包面，与 `packages/llm-router` 的
 * `entry-boundary.test.ts` 配对）。
 *
 * 那一份守的是「两个子路径入口的产物里没有解封代码」；这一份守的是
 * 「web 只从那两个子路径引」。少了任何一半，`/api/v1/llm/*` 下随手写一句
 * `from '@open-rush/llm-router'` 就会把网关那一整套（含解封函数）拉回
 * web 的构建产物里——没有调用点，但审计脚本会 grep 到，说法也就不成立了。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SELF = fileURLToPath(import.meta.url);
const LLM_API_DIR = join(dirname(SELF), '..');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    // 排除本文件：它为了描述禁止的写法，正文里必然出现那几个字面量。
    else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && full !== SELF) out.push(full);
  }
  return out;
}

describe('apps/web 对 @open-rush/llm-router 的 import 边界', () => {
  const files = collectTsFiles(LLM_API_DIR);

  it('扫到了 /api/v1/llm 下的源文件（防止用例因为路径写错而空跑）', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each([
    ["from '@open-rush/llm-router'", '静态 import'],
    ["import('@open-rush/llm-router')", '动态 import'],
    ["vi.mock('@open-rush/llm-router'", 'vi.mock'],
  ])('没有任何文件用裸的 `.` 入口（%s）', (needle) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(needle));
    expect(offenders).toEqual([]);
  });

  it('确实在用两个子路径入口', () => {
    const all = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(all).toContain('@open-rush/llm-router/sealing');
    expect(all).toContain('@open-rush/llm-router/store');
  });
});
