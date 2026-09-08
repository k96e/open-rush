import { index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * 供应商真实密钥的**密文**存储（llm-router）。
 *
 * 安全不变量（specs/llm-router.md §密钥边界）：
 * 1. 本表**没有任何明文列**，也没有可解密回明文的对称密钥存在于 web/control-plane。
 * 2. `sealed_value` 由 apps/web 用 LLM_ROUTER_PUBLIC_KEY 单向封装（X25519 sealed box）。
 *    对应私钥只存在于 llm-router 进程，web 侧物理上无法解封。
 * 3. `/api/v1/llm/credentials` 的任何响应**永不包含** `sealed_value`
 *    （契约侧闸门见 packages/contracts/src/v1/llm-router.ts 的 `llmCredentialSchema`）。
 * 4. 轮换 = 覆盖 `sealed_value` + `version++`，**不保留历史密文**
 *    （A8：「旧密钥不可从持久层还原」）。
 */
export const llmCredentials = pgTable(
  'llm_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 人类可读标识，控制台按名字引用，如 'anthropic-prod' */
    name: varchar('name', { length: 100 }).notNull().unique(),
    /** 封装算法标识；当前唯一合法值 'x25519-hkdf-sha256-aes256gcm' */
    alg: varchar('alg', { length: 40 }).notNull().default('x25519-hkdf-sha256-aes256gcm'),
    /** 收件公钥指纹（SHA-256(raw pub) 前 32 hex）。router 启动时比对，指纹不符即拒绝解封 */
    keyId: varchar('key_id', { length: 64 }).notNull(),
    /** base64(ephPub32 || iv12 || tag16 || ciphertext) */
    sealedValue: text('sealed_value').notNull(),
    /** 上游认证方式：bearer → Authorization: Bearer；x-api-key → x-api-key；header → 用 authHeader */
    authStyle: varchar('auth_style', { length: 20 }).notNull().default('bearer'),
    authHeader: varchar('auth_header', { length: 64 }),
    /** 轮换计数，从 1 开始 */
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [index('llm_credentials_key_id_idx').on(t.keyId)]
);
