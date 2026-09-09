import { defineConfig } from 'tsup';

/**
 * 三个入口，**关掉 code splitting**。
 *
 * 开着 splitting 的话，tsup 会把 `.` 与 `./store` 共用的模块提到一个共享 chunk 里，
 * 而那个 chunk 同时被 `.` 引用，于是解封代码又会随着 `./store` 一起被打进
 * apps/web 的产物——子路径导出就白拆了。关掉之后每个入口自成一体：
 * `sealing.js` 与 `store.js` 的字节里不会出现解封函数（`pnpm test` 里有一条
 * 断言直接对 dist 做这个检查）。
 *
 * 代价是 `.` 与 `./store` 的 store 代码各有一份。网关与 web 是两个进程，
 * 谁也不会同时加载两个入口，这份重复不产生运行时成本。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/sealing.ts', 'src/store.ts', 'src/token.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  clean: true,
});
