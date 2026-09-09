/**
 * `@open-rush/llm-router/sealing` —— **封装侧的子路径导出**。
 *
 * apps/web 只 import 这个入口。它的模块图里只有 `crypto/{envelope,seal}.ts`：
 * 解封函数所在的 `crypto/open-sealed.ts` **物理上不在图里**，所以 web 的构建
 * 产物里不会出现那段代码——不是靠 tree-shaking 侥幸摇掉，是根本没被引用到。
 *
 * 为什么要这么拆：包的 `.` 入口是给网关（apps/llm-router）用的，上面挂着转发、
 * 令牌认证、解封等一整套只有网关才需要的东西。web 从 `.` 引任何一个符号，
 * 打包器都会把整个入口拉进来。密码学前提本来就不受影响（web 侧没有私钥，
 * 那段代码在 web 里也无从调用），但「web 的产物里连那段代码都不该有」这条
 * 更强的说法要成立，必须在**入口层面**切开。
 */
export {
  computeKeyId,
  SEALED_BOX_ALG,
  type SealedEnvelope,
} from './crypto/envelope.js';
export { generateRouterKeyPair, seal } from './crypto/seal.js';
