/**
 * 本包单测用的最小 PGlite 库：只建 M2/M3/M4 触到的六张表。
 *
 * 与 `packages/control-plane` 的 drizzle-* 测试同款——就地写 DDL，不去 import
 * 另一个 package 的测试内部件。DDL 逐字对齐 `0012_llm_router.sql`（含 CHECK 与
 * FK 的 onDelete），否则这里绿了、真库上仍会红。
 */
import { PGlite } from '@electric-sql/pglite';
import * as schema from '@open-rush/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function createTestDb(): Promise<{ db: TestDb; pglite: PGlite }> {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });

  await db.execute(sql`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      email TEXT UNIQUE,
      email_verified_at TIMESTAMPTZ,
      image TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE llm_catalog_state (
      id INTEGER PRIMARY KEY DEFAULT 1 NOT NULL,
      version BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT llm_catalog_state_singleton CHECK (id = 1)
    )
  `);

  await db.execute(sql`
    CREATE TABLE llm_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      alg VARCHAR(40) NOT NULL DEFAULT 'x25519-hkdf-sha256-aes256gcm',
      key_id VARCHAR(64) NOT NULL,
      sealed_value TEXT NOT NULL,
      auth_style VARCHAR(20) NOT NULL DEFAULT 'bearer',
      auth_header VARCHAR(64),
      version INTEGER NOT NULL DEFAULT 1,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      rotated_at TIMESTAMPTZ,
      CONSTRAINT llm_credentials_name_unique UNIQUE(name),
      CONSTRAINT llm_credentials_auth_style_check
        CHECK (auth_style IN ('bearer','x-api-key','header')),
      CONSTRAINT llm_credentials_auth_header_check
        CHECK (auth_style <> 'header' OR auth_header IS NOT NULL)
    )
  `);

  await db.execute(sql`
    CREATE TABLE llm_providers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      protocol VARCHAR(20) NOT NULL,
      base_url TEXT NOT NULL,
      credential_id UUID REFERENCES llm_credentials(id) ON DELETE RESTRICT,
      default_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
      timeout_ms INTEGER NOT NULL DEFAULT 600000,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT llm_providers_name_unique UNIQUE(name),
      CONSTRAINT llm_providers_protocol_check CHECK (protocol IN ('anthropic','openai'))
    )
  `);

  await db.execute(sql`
    CREATE TABLE llm_models (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      alias VARCHAR(255) NOT NULL,
      provider_id UUID NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
      upstream_model VARCHAR(255) NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT true,
      display_name VARCHAR(255),
      max_output_tokens INTEGER,
      price_input_per_mtok NUMERIC(12, 6) NOT NULL DEFAULT '0',
      price_output_per_mtok NUMERIC(12, 6) NOT NULL DEFAULT '0',
      price_cache_write_per_mtok NUMERIC(12, 6) NOT NULL DEFAULT '0',
      price_cache_read_per_mtok NUMERIC(12, 6) NOT NULL DEFAULT '0',
      price_reasoning_per_mtok NUMERIC(12, 6) NOT NULL DEFAULT '0',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT llm_models_alias_provider_idx UNIQUE(alias, provider_id)
    )
  `);

  // M4·T4.2 的调用方令牌。**刻意不建 run/agent/project 的外键**——那三张表的
  // 建表 DDL 有几十列，而级联行为已由 `packages/db` 的 migration.test.ts 覆盖；
  // 本包的单测要证的是「未吊销 + 未过期」这条查询条件，不是外键。
  await db.execute(sql`
    CREATE TABLE llm_router_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL,
      subject_type VARCHAR(20) NOT NULL,
      run_id UUID,
      agent_id UUID,
      project_id UUID,
      owner_user_id UUID,
      allowed_model_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
      max_cost_usd NUMERIC(12, 6),
      max_requests_per_minute INTEGER,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT llm_router_tokens_subject_check
        CHECK ((subject_type = 'run' AND run_id IS NOT NULL) OR subject_type = 'service')
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX llm_router_tokens_hash_uniq ON llm_router_tokens (token_hash)`
  );

  // migration 末尾的种子行——版本位必须存在，bumpCatalogVersion 只写 WHERE id = 1。
  await db.execute(sql`INSERT INTO llm_catalog_state (id, version) VALUES (1, 0)`);

  return { db, pglite };
}

export async function closeTestDb(pglite: PGlite): Promise<void> {
  await pglite.close();
}

/** 清空 M2/M3/M4 相关表并重播 `llm_catalog_state` 种子行。 */
export async function truncateAll(db: TestDb): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE llm_router_tokens, llm_models, llm_providers, llm_credentials, llm_catalog_state, users RESTART IDENTITY CASCADE`
  );
  await db.execute(sql`INSERT INTO llm_catalog_state (id, version) VALUES (1, 0)`);
}
