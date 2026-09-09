/**
 * X25519 sealed box 的**共享原语**（D3 / 盲写不变量 1–2）。
 *
 * 安全模型（specs/llm-router.md §密钥边界）：
 * - apps/web 只拿到公钥（`LLM_ROUTER_PUBLIC_KEY`），可以封装，**无法解封**。
 *   这不是策略约束，是密码学约束——web 进程里根本没有私钥材料。
 * - apps/llm-router 独占私钥，只在转发时于栈上解封。
 * - 每次封装使用一次性临时密钥对，密文之间不可关联；AES-GCM 保证篡改可检测。
 *
 * 密文布局：`base64( ephPub[32] || iv[12] || tag[16] || ciphertext )`
 *
 * ⚠️ 本文件**刻意不含**封装与解封函数本身，两者分别在 `seal.ts` 与
 * `open-sealed.ts`。拆开是为了让 `@open-rush/llm-router/sealing` 子路径导出的
 * 模块图里**物理上不存在**解封代码——apps/web 只 import 那个子路径，打进 bundle
 * 的就只有封装侧，而不是指望打包器的 tree-shaking 恰好把它摇掉。
 */
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

/** 封装算法标识。落在 `llm_credentials.alg`，当前唯一合法值。 */
export const SEALED_BOX_ALG = 'x25519-hkdf-sha256-aes256gcm';

/** HKDF 的 info 串——绑定用途，避免同一密钥材料在别处被复用。 */
export const INFO = Buffer.from('open-rush/llm-router/v1');

/** X25519 SPKI DER 前缀（固定 12 字节），用于把 32 字节裸公钥还原成 KeyObject。 */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** 头部固定长度：ephPub(32) + iv(12) + tag(16)。密文至少这么长。 */
export const HEADER_BYTES = 32 + 12 + 16;

export interface SealedEnvelope {
  /** 算法标识，见 {@link SEALED_BOX_ALG}。 */
  alg: string;
  /** 收件公钥指纹，router 解封前比对；指纹不符直接拒绝（防止错配密钥对）。 */
  keyId: string;
  /** base64(ephPub32 || iv12 || tag16 || ciphertext) */
  value: string;
}

export function rawPub(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return der.subarray(der.length - 32);
}

export function pubFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** 公钥指纹 = SHA-256(裸公钥) 的前 32 个 hex 字符。 */
export function computeKeyId(publicKey: KeyObject): string {
  return createHash('sha256').update(rawPub(publicKey)).digest('hex').slice(0, 32);
}
