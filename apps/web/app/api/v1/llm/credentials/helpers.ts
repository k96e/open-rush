/**
 * `/api/v1/llm/credentials/*` 的共用件（M2·T2.3）。
 *
 * 两个职责，各自对应一条盲写不变量（specs/llm-router.md §密钥边界）：
 *
 * - {@link resolveRouterPublicKey} —— 拿到 `LLM_ROUTER_PUBLIC_KEY`，或者返回一个
 *   现成的 v1 `INTERNAL` 500。公钥缺失是**服务端配置错误**，不是调用方传错了
 *   参数，所以不能是 VALIDATION_ERROR。范式抄 `vaults/entries/helpers.ts`
 *   的 `resolveVault()`。
 *
 * - {@link credentialToV1} —— 手写投影。`v1Success<T>` 是无约束泛型、不跑
 *   schema，所以「响应里没有密文」这件事**只能**靠这个函数保证：领域对象
 *   {@link CredentialSummary} 本身就不含 `sealedValue`，这里再逐字段列一遍，
 *   将来有人给领域类型加了密文字段，也必须先改这里才会漏出去。
 *
 * ⚠️ 本文件所在的整棵目录里不得出现解封函数或 router 私钥环境变量——web 进程
 * 物理上不该具备解封能力。M7·T7.3 的审计脚本按标识符 grep，所以连注释里也不
 * 写它们的字面量。
 */
import type { v1 } from '@open-rush/contracts';
import { getDbClient } from '@open-rush/db';
import {
  bumpCatalogVersion,
  type CredentialSummary,
  DrizzleCredentialStore,
  type SealedEnvelope,
  seal,
} from '@open-rush/llm-router';

import { v1Error } from '@/lib/api/v1-responses';

export type ResolvedPublicKey =
  | { readonly publicKeyPem: string; readonly error?: never }
  | { readonly publicKeyPem?: never; readonly error: Response };

const MISSING_HINT =
  'Set LLM_ROUTER_PUBLIC_KEY (X25519 SPKI PEM, or its base64 form) in the web environment. ' +
  'Generate a pair with: pnpm llm:keygen';

/**
 * 读取并规范化公钥。接受两种写法：
 *   - 直接的 PEM（含 `BEGIN PUBLIC KEY`）
 *   - 单行 base64 包装的 PEM（`pnpm llm:keygen` 输出的 env 形式）
 *
 * 只做形状归一，不做密码学校验——真正的校验在 `seal()` 里由 `createPublicKey`
 * 完成，失败会被 POST/rotate 的 catch 兜成 INTERNAL。
 *
 * 入参是**那一个字符串**而不是整个 env 对象：Next 把 `NodeJS.ProcessEnv` augment
 * 成带必填 `NODE_ENV`，传 env 字面量会在 `next build` 的类型检查里炸。
 */
export function resolveRouterPublicKey(
  configured: string | undefined = process.env.LLM_ROUTER_PUBLIC_KEY
): ResolvedPublicKey {
  const raw = configured?.trim();
  if (!raw) {
    return {
      error: v1Error('INTERNAL', 'LLM_ROUTER_PUBLIC_KEY is not configured', { hint: MISSING_HINT }),
    };
  }
  const publicKeyPem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return { publicKeyPem };
}

/**
 * 用公钥封装明文，或返回一个成形的 500。
 *
 * **调用方拿到结果后必须立刻丢弃明文引用**——不进日志、不进错误信息、不进响应。
 * 这里刻意不把 plaintext 放进任何错误串：公钥格式错也只说「公钥错」。
 */
export function sealCredentialValue(
  publicKeyPem: string,
  plaintext: string
): { envelope: SealedEnvelope; error?: never } | { envelope?: never; error: Response } {
  try {
    return { envelope: seal(publicKeyPem, plaintext) };
  } catch (err) {
    // 只回显异常类型，绝不回显明文或密文片段。
    const reason = err instanceof Error ? err.message : String(err);
    return {
      error: v1Error('INTERNAL', `LLM_ROUTER_PUBLIC_KEY is malformed: ${reason}`, {
        hint: MISSING_HINT,
      }),
    };
  }
}

/**
 * 写成功后 bump 目录版本位（D7）。**每个** POST / DELETE / rotate 都必须调用，
 * 否则 router 副本永远看不到这次变更——`00-必读.md` §五③ 点名的坑。
 *
 * 失败只记 error 日志，不回滚也不谎报 500：资源确实已经落库，返回失败会让
 * 客户端重试并撞上 409。代价是这条变更要等下一次目录写才会被副本看到，日志里
 * 把这个后果写清楚。
 */
export async function bumpCatalogAfterWrite(credentialId: string): Promise<void> {
  try {
    await bumpCatalogVersion(getDbClient());
  } catch (err) {
    console.error(
      `[llm/credentials] catalog version bump failed after writing ${credentialId}; ` +
        'router replicas will not pick this change up until the next catalog write',
      err
    );
  }
}

/** 构造凭据 store。单独一个函数，方便三个路由文件共用同一份装配。 */
export function credentialStore(): DrizzleCredentialStore {
  return new DrizzleCredentialStore(getDbClient());
}

/**
 * 领域对象 → v1 线上形状。**显式投影**，绝不 spread。
 *
 * 对应 `llmCredentialSchema`：结构上没有 `sealedValue` / `value`。
 */
export function credentialToV1(c: CredentialSummary): v1.LlmCredential {
  return {
    id: c.id,
    name: c.name,
    alg: c.alg,
    keyId: c.keyId,
    authStyle: c.authStyle as v1.LlmCredential['authStyle'],
    authHeader: c.authHeader,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    rotatedAt: c.rotatedAt ? c.rotatedAt.toISOString() : null,
  };
}
