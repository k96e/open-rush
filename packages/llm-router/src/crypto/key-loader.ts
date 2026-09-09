/**
 * llm-router 私钥装载（fail-fast）。
 *
 * 优先级（从高到低）：
 *   1. `LLM_ROUTER_PRIVATE_KEY_FILE` —— 指向挂载的文件（K8s Secret volume，推荐）
 *   2. `LLM_ROUTER_PRIVATE_KEY`      —— PEM 内容，允许 base64 包装
 *
 * 任一失败 → 抛错，由调用方在启动阶段退出进程。**不要**带着「能转发但不能
 * 解封」的半残状态跑起来：那会让每一次真实调用都在上游认证处才炸。
 *
 * 运维要求（A11 的 grep 探针）：`LLM_ROUTER_PRIVATE_KEY*` 只允许出现在
 * llm-router 的 Deployment/Secret 中；web / control-worker 上必须为空。
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { computeKeyId } from './sealed-box.js';

export interface RouterKeyMaterial {
  privateKeyPem: string;
  /** 与信封里的 `keyId` 比对，不符即拒绝解封。 */
  keyId: string;
}

/**
 * 允许 env 被显式传入，便于测试；默认读 `process.env`。
 *
 * 两个键都是可选的——`process.env`（索引签名）与测试里的字面量对象都要能传进来。
 */
export interface RouterKeyEnv {
  LLM_ROUTER_PRIVATE_KEY_FILE?: string | undefined;
  LLM_ROUTER_PRIVATE_KEY?: string | undefined;
}

const MISSING_MESSAGE =
  'llm-router: neither LLM_ROUTER_PRIVATE_KEY_FILE nor LLM_ROUTER_PRIVATE_KEY is set. ' +
  'Generate a pair with: pnpm llm:keygen';

export function loadRouterPrivateKey(env: RouterKeyEnv = process.env): RouterKeyMaterial {
  const file = env.LLM_ROUTER_PRIVATE_KEY_FILE?.trim();
  const inline = env.LLM_ROUTER_PRIVATE_KEY?.trim();

  let pem: string | undefined;
  if (file) {
    // FILE 优先：文件读不到就抛，**不要**静默回退到 inline——那会在密钥轮换
    // 期间悄悄用回旧的 inline 值。
    pem = readFileSync(file, 'utf8').trim();
  } else if (inline) {
    pem = inline.includes('BEGIN') ? inline : Buffer.from(inline, 'base64').toString('utf8');
  }

  if (!pem) throw new Error(MISSING_MESSAGE);

  const priv = createPrivateKey(pem); // 非法 PEM 在此抛错
  if (priv.asymmetricKeyType !== 'x25519') {
    throw new Error(`llm-router: expected an X25519 private key, got ${priv.asymmetricKeyType}`);
  }
  return { privateKeyPem: pem, keyId: computeKeyId(createPublicKey(priv)) };
}
