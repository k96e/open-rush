/**
 * sealed box 的聚合出口（保持 M2 以来的 import 路径不变）。
 *
 * 三个实现文件的分工：
 *  - `envelope.ts`   —— 共享原语（算法标识、公钥指纹、裸公钥编解码），两侧都要；
 *  - `seal.ts`       —— 封装侧 + 密钥对生成，**apps/web 允许持有**；
 *  - `open-sealed.ts`—— 解封侧，**只属于 llm-router 进程**。
 *
 * 本文件把三者拼回一个面，供网关与本包内部使用。apps/web 不 import 它——
 * web 走 `@open-rush/llm-router/sealing`（只含前两者）。
 */
export {
  computeKeyId,
  HEADER_BYTES,
  SEALED_BOX_ALG,
  type SealedEnvelope,
} from './envelope.js';
export { openSealed } from './open-sealed.js';
export { generateRouterKeyPair, seal } from './seal.js';
