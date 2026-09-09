/**
 * 封装侧 + 密钥对生成。**这一半允许出现在 apps/web 的 bundle 里。**
 *
 * 解封在 `open-sealed.ts`，只属于 llm-router 进程。两者拆成不同模块，
 * `@open-rush/llm-router/sealing` 子路径导出的模块图才能在物理上不含解封代码。
 */
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { computeKeyId, INFO, rawPub, SEALED_BOX_ALG, type SealedEnvelope } from './envelope.js';

/** 部署前生成一次；公钥给 web，私钥只给 llm-router。见 scripts/gen-router-keypair.ts。 */
export function generateRouterKeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    keyId: computeKeyId(publicKey),
  };
}

/**
 * apps/web 侧唯一会调用的函数。**调用后立即丢弃 plaintext 引用**——
 * 不进日志、不进错误信息、不进响应体。
 */
export function seal(recipientPublicKeyPem: string, plaintext: string): SealedEnvelope {
  const recipient = createPublicKey(recipientPublicKeyPem);
  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: recipient });
  const ephRaw = rawPub(ephPub);
  // salt 绑定双方公钥，避免密文在不同收件人之间被重放。
  const salt = Buffer.concat([ephRaw, rawPub(recipient)]);
  const dek = Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  dek.fill(0);
  shared.fill(0);
  return {
    alg: SEALED_BOX_ALG,
    keyId: computeKeyId(recipient),
    value: Buffer.concat([ephRaw, iv, tag, ct]).toString('base64'),
  };
}
