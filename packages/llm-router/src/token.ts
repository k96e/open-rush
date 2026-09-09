/**
 * `@open-rush/llm-router/token` —— **令牌铸造的子路径导出**（M6·T6.1）。
 *
 * `packages/control-plane` 的 `LlmAccessService` 只需要「铸一个明文 + 存它的
 * SHA-256」这两件事。从 `.` 引会把网关那一整套转发 / 认证 / 解封代码拉进
 * control-plane，而 control-plane 是 apps/web 的依赖——等于把 M4 后续刚拆掉的
 * 东西原样引回去。所以这里单开一个入口，模块图里只有 `auth/mint.ts`
 * （只 import `node:crypto`）。
 *
 * ⚠️ 新增导出前先想清楚：这个入口的下游是 web。凡是「只有网关该有」的东西
 * （解封、转发、目录、私钥加载）一律不放这里。
 */
export { hashRouterToken, mintRouterToken, ROUTER_TOKEN_PREFIX } from './auth/mint.js';
