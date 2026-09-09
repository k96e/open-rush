/**
 * PostgreSQL 错误码识别（M3·T3.4 抽出，M2 的 credential-store 一并复用）。
 *
 * 把驱动细节挡在库层里：路由层只认领域错误类型，不认 SQLSTATE。
 */

/** 23505 = unique_violation */
export const UNIQUE_VIOLATION = '23505';
/** 23503 = foreign_key_violation */
export const FK_VIOLATION = '23503';

/**
 * 取 PostgreSQL 的 SQLSTATE。
 *
 * drizzle 0.45 把驱动错误包进 `DrizzleQueryError`，真正带 `code` 的是 `cause`
 * （PGlite 与 postgres.js 都是如此），所以要顺着 cause 链找。
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * FK 违例的错误信息里带着约束名（如
 * `llm_providers_credential_id_llm_credentials_id_fk`）。用它区分「引用了不存在
 * 的凭据」与其他外键问题——两者的 v1 码位不同。
 */
export function pgConstraintName(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (
      typeof current === 'object' &&
      'constraint_name' in current &&
      typeof (current as { constraint_name?: unknown }).constraint_name === 'string'
    ) {
      return (current as { constraint_name: string }).constraint_name;
    }
    if (
      typeof current === 'object' &&
      'constraint' in current &&
      typeof (current as { constraint?: unknown }).constraint === 'string'
    ) {
      return (current as { constraint: string }).constraint;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
