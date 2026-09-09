/**
 * 解封侧。**只允许在 llm-router 进程内被 import。**
 *
 * 单独成文件的原因见 `seal.ts`：apps/web 走 `@open-rush/llm-router/sealing`
 * 子路径，那条模块图里不会出现本文件，M7·T7.3 的审计脚本因此可以直接对
 * `apps/web/.next` 的产物 grep 而不只是对源码 grep。
 */
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';
import {
  computeKeyId,
  HEADER_BYTES,
  INFO,
  pubFromRaw,
  rawPub,
  SEALED_BOX_ALG,
  type SealedEnvelope,
} from './envelope.js';

/**
 * 只在 llm-router 进程内调用。返回值是**明文密钥**，禁止落库 / 日志 / 响应。
 *
 * 失败信息里绝不回显密文片段——调用方只应把 credential 的 name 拼进错误。
 */
export function openSealed(recipientPrivateKeyPem: string, env: SealedEnvelope): string {
  if (env.alg !== SEALED_BOX_ALG) throw new Error(`unsupported alg: ${env.alg}`);
  const priv = createPrivateKey(recipientPrivateKeyPem);
  const derivedPub = createPublicKey(priv);
  const routerKeyId = computeKeyId(derivedPub);
  if (routerKeyId !== env.keyId) {
    throw new Error(`keyId mismatch: envelope=${env.keyId} router=${routerKeyId}`);
  }
  const buf = Buffer.from(env.value, 'base64');
  if (buf.length <= HEADER_BYTES) throw new Error('malformed sealed envelope');
  const ephRaw = buf.subarray(0, 32);
  const iv = buf.subarray(32, 44);
  const tag = buf.subarray(44, HEADER_BYTES);
  const ct = buf.subarray(HEADER_BYTES);
  const shared = diffieHellman({ privateKey: priv, publicKey: pubFromRaw(ephRaw) });
  const salt = Buffer.concat([ephRaw, rawPub(derivedPub)]);
  const dek = Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
  const d = createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  dek.fill(0);
  shared.fill(0);
  return out;
}
