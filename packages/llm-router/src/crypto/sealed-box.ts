/**
 * X25519 sealed box —— 单向封装供应商密钥（D3 / 盲写不变量 1–2）。
 *
 * 安全模型（specs/llm-router.md §密钥边界）：
 * - apps/web 只拿到公钥（`LLM_ROUTER_PUBLIC_KEY`），可以 {@link seal}，
 *   **无法 {@link openSealed}**。这不是策略约束，是密码学约束——web 进程里
 *   根本没有私钥材料。
 * - apps/llm-router 独占私钥（`LLM_ROUTER_PRIVATE_KEY`），只在转发时于栈上解封。
 * - 每次 seal 使用一次性临时密钥对，密文之间不可关联；AES-GCM 保证篡改可检测。
 *
 * 密文布局：`base64( ephPub[32] || iv[12] || tag[16] || ciphertext )`
 *
 * ⚠️ {@link openSealed} 的返回值是明文供应商密钥：**禁止落库、禁止日志、
 * 禁止放进任何响应**。调用方用完即弃。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';

/** 封装算法标识。落在 `llm_credentials.alg`，当前唯一合法值。 */
export const SEALED_BOX_ALG = 'x25519-hkdf-sha256-aes256gcm';

/** HKDF 的 info 串——绑定用途，避免同一密钥材料在别处被复用。 */
const INFO = Buffer.from('open-rush/llm-router/v1');

/** X25519 SPKI DER 前缀（固定 12 字节），用于把 32 字节裸公钥还原成 KeyObject。 */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** 头部固定长度：ephPub(32) + iv(12) + tag(16)。密文至少这么长。 */
const HEADER_BYTES = 32 + 12 + 16;

export interface SealedEnvelope {
  /** 算法标识，见 {@link SEALED_BOX_ALG}。 */
  alg: string;
  /** 收件公钥指纹，router 解封前比对；指纹不符直接拒绝（防止错配密钥对）。 */
  keyId: string;
  /** base64(ephPub32 || iv12 || tag16 || ciphertext) */
  value: string;
}

function rawPub(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return der.subarray(der.length - 32);
}

function pubFromRaw(raw: Buffer): KeyObject {
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
