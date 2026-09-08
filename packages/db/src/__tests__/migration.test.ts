import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DRIZZLE_DIR = resolve(import.meta.dirname, '../../drizzle');

/** 在一个干净的 PGlite 实例上重放全链 migration。 */
async function replayAllMigrations(pg: PGlite): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sqlContent = readFileSync(resolve(DRIZZLE_DIR, file), 'utf-8');
    const statements = sqlContent
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pg.exec(stmt);
    }
  }
}

describe('migration files', () => {
  it('drizzle directory exists', () => {
    expect(existsSync(DRIZZLE_DIR)).toBe(true);
  });

  it('has at least one migration', () => {
    const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('migrations are sequentially numbered', () => {
    const files = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (let i = 0; i < files.length; i++) {
      const prefix = files[i].split('_')[0];
      expect(prefix).toBe(String(i).padStart(4, '0'));
    }
  });

  it('meta directory exists with journal', () => {
    const metaDir = resolve(DRIZZLE_DIR, 'meta');
    expect(existsSync(metaDir)).toBe(true);
    expect(existsSync(resolve(metaDir, '_journal.json'))).toBe(true);
  });
});

describe('migration replay on clean database', () => {
  let pglite: PGlite;

  afterAll(async () => {
    await pglite?.close();
  });

  it('all migrations replay successfully on a clean PGlite instance', async () => {
    pglite = new PGlite();

    const files = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sqlContent = readFileSync(resolve(DRIZZLE_DIR, file), 'utf-8');
      const statements = sqlContent
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);

      for (const stmt of statements) {
        await pglite.exec(stmt);
      }
    }

    const result = await pglite.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    const tables = result.rows.map((r) => r.tablename);

    expect(tables).toContain('users');
    expect(tables).toContain('projects');
    expect(tables).toContain('tasks');
    expect(tables).toContain('runs');
    expect(tables).toContain('agents');
    expect(tables).toContain('run_events');
    expect(tables).toContain('sandboxes');
    expect(tables).toContain('vault_entries');
    expect(tables).toContain('agent_definition_versions');
    expect(tables).toContain('service_tokens');
    // 0012_llm_router.sql —— 7 张 llm_* 表
    expect(tables).toContain('llm_credentials');
    expect(tables).toContain('llm_providers');
    expect(tables).toContain('llm_models');
    expect(tables).toContain('llm_router_tokens');
    expect(tables).toContain('llm_calls');
    expect(tables).toContain('llm_budgets');
    expect(tables).toContain('llm_budget_usage');
    expect(tables).toContain('llm_catalog_state');
  });

  it('service_tokens partial active index exists with correct predicate', async () => {
    const pg = new PGlite();
    try {
      const files = readdirSync(DRIZZLE_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        const sqlContent = readFileSync(resolve(DRIZZLE_DIR, file), 'utf-8');
        const statements = sqlContent
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const stmt of statements) {
          await pg.exec(stmt);
        }
      }

      const result = await pg.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'service_tokens'`
      );
      const idxs = result.rows;
      const activeIdx = idxs.find((r) => r.indexname === 'service_tokens_active_idx');
      expect(activeIdx).toBeDefined();
      expect(activeIdx?.indexdef).toMatch(/revoked_at IS NULL/i);

      const uniqIdx = idxs.find((r) => r.indexname === 'service_tokens_token_hash_uniq');
      expect(uniqIdx).toBeDefined();
      expect(uniqIdx?.indexdef).toMatch(/UNIQUE/i);

      const ownerIdx = idxs.find((r) => r.indexname === 'service_tokens_owner_idx');
      expect(ownerIdx).toBeDefined();
    } finally {
      await pg.close();
    }
  });

  it('agents table gains current_version/archived_at via 0009 migration', async () => {
    const pg = new PGlite();
    try {
      const files = readdirSync(DRIZZLE_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        const sqlContent = readFileSync(resolve(DRIZZLE_DIR, file), 'utf-8');
        const statements = sqlContent
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const stmt of statements) {
          await pg.exec(stmt);
        }
      }

      const result = await pg.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'agents'
         ORDER BY column_name`
      );
      const cols = result.rows.map((r) => r.column_name);
      expect(cols).toContain('current_version');
      expect(cols).toContain('archived_at');
    } finally {
      await pg.close();
    }
  });

  it('initial-snapshot backfill inserts a v1 row for every pre-existing agent', async () => {
    const pg = new PGlite();
    try {
      const files = readdirSync(DRIZZLE_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      // Apply migrations up to (but excluding) the 0009 one that backfills snapshots
      const preMigrations = files.filter((f) => f < '0009');
      for (const file of preMigrations) {
        const sqlContent = readFileSync(resolve(DRIZZLE_DIR, file), 'utf-8');
        const statements = sqlContent
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const stmt of statements) {
          await pg.exec(stmt);
        }
      }

      // Seed a project + user + agent BEFORE 0009 runs, to simulate existing data
      await pg.exec(`
        INSERT INTO users (id, name, email) VALUES
          ('00000000-0000-0000-0000-000000000001', 'seed', 'seed@example.com')
      `);
      await pg.exec(`
        INSERT INTO projects (id, name, created_by) VALUES
          ('00000000-0000-0000-0000-000000000002', 'seed-project', '00000000-0000-0000-0000-000000000001')
      `);
      await pg.exec(`
        INSERT INTO agents (id, project_id, created_by) VALUES
          ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001'),
          ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001')
      `);

      // Now apply 0009
      const content = readFileSync(
        resolve(DRIZZLE_DIR, '0009_agent_definition_versions.sql'),
        'utf-8'
      );
      const statements = content
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await pg.exec(stmt);
      }

      const versions = await pg.query<{
        agent_id: string;
        version: number;
        snapshot: Record<string, unknown>;
      }>(`SELECT agent_id, version, snapshot FROM agent_definition_versions ORDER BY agent_id`);

      expect(versions.rows).toHaveLength(2);
      for (const row of versions.rows) {
        expect(row.version).toBe(1);
        expect(row.snapshot).toBeTypeOf('object');
        // Snapshot must exclude identity and runtime-state columns per spec.
        expect(row.snapshot).not.toHaveProperty('id');
        expect(row.snapshot).not.toHaveProperty('created_at');
        expect(row.snapshot).not.toHaveProperty('updated_at');
        expect(row.snapshot).not.toHaveProperty('last_active_at');
        expect(row.snapshot).not.toHaveProperty('active_stream_id');
        expect(row.snapshot).not.toHaveProperty('current_version');
        expect(row.snapshot).not.toHaveProperty('archived_at');
      }

      const agentsRes = await pg.query<{ current_version: number; archived_at: string | null }>(
        `SELECT current_version, archived_at FROM agents ORDER BY id`
      );
      for (const row of agentsRes.rows) {
        expect(row.current_version).toBe(1);
        expect(row.archived_at).toBeNull();
      }
    } finally {
      await pg.close();
    }
  });
});

describe('0012_llm_router migration', () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await replayAllMigrations(pg);
  }, 60000);

  afterAll(async () => {
    await pg?.close();
  });

  it('seeds llm_catalog_state with exactly one row at version 0', async () => {
    const result = await pg.query<{ id: number; version: string }>(
      'SELECT id, version FROM llm_catalog_state'
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(1);
    expect(Number(result.rows[0].version)).toBe(0);
  });

  it('0012 really ends with the seed INSERT, and replaying it is idempotent', () => {
    // 从文件里把种子语句抠出来再执行——否则这个用例会自己插一行，
    // 于是「migration 里的种子被删掉」也照样绿。
    const migration = readFileSync(resolve(DRIZZLE_DIR, '0012_llm_router.sql'), 'utf-8');
    const statements = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    const seed = statements[statements.length - 1];

    expect(seed).toMatch(/INSERT INTO "llm_catalog_state"/);
    expect(seed).toMatch(/VALUES\s*\(1,\s*0\)/);
    expect(seed).toMatch(/ON CONFLICT \("id"\) DO NOTHING/);
  });

  it('replaying the migration seed statement does not duplicate the row', async () => {
    const migration = readFileSync(resolve(DRIZZLE_DIR, '0012_llm_router.sql'), 'utf-8');
    const statements = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    await pg.exec(statements[statements.length - 1]);

    const result = await pg.query('SELECT id FROM llm_catalog_state');
    expect(result.rows).toHaveLength(1);
  });

  it('llm_catalog_state_singleton rejects a second row', async () => {
    await expect(
      pg.exec(`INSERT INTO llm_catalog_state (id, version) VALUES (2, 5)`)
    ).rejects.toThrow();

    const result = await pg.query('SELECT id FROM llm_catalog_state');
    expect(result.rows).toHaveLength(1);
  });

  it('the budget tables pin subject_type / window to the contract enums', async () => {
    await expect(
      pg.exec(
        `INSERT INTO llm_budgets (subject_type, subject_id, "window", limit_usd)
         VALUES ('Global', NULL, 'day', 1)`
      )
    ).rejects.toThrow();

    await expect(
      pg.exec(
        `INSERT INTO llm_budgets (subject_type, subject_id, "window", limit_usd)
         VALUES ('global', NULL, 'weekly', 1)`
      )
    ).rejects.toThrow();

    await expect(
      pg.exec(
        `INSERT INTO llm_budget_usage (subject_type, subject_id, window_key)
         VALUES ('Global', NULL, 'total')`
      )
    ).rejects.toThrow();
  });

  it('llm_credentials pins auth_style and requires auth_header for the header style', async () => {
    await expect(
      pg.exec(
        `INSERT INTO llm_credentials (name, key_id, sealed_value, auth_style)
         VALUES ('bogus-style', 'k', 's', 'bogus')`
      )
    ).rejects.toThrow();

    await expect(
      pg.exec(
        `INSERT INTO llm_credentials (name, key_id, sealed_value, auth_style)
         VALUES ('header-no-header', 'k', 's', 'header')`
      )
    ).rejects.toThrow();
  });

  it('every llm_* table has a primary key (logical replication needs one)', async () => {
    const result = await pg.query<{ tbl: string }>(
      `SELECT c.conrelid::regclass::text AS tbl
       FROM pg_constraint c
       WHERE c.contype = 'p' AND c.conrelid::regclass::text LIKE 'llm\\_%'
       ORDER BY tbl`
    );

    expect(result.rows.map((r) => r.tbl)).toEqual([
      'llm_budget_usage',
      'llm_budgets',
      'llm_calls',
      'llm_catalog_state',
      'llm_credentials',
      'llm_models',
      'llm_providers',
      'llm_router_tokens',
    ]);
  });

  it('llm_credentials carries no plaintext column', async () => {
    const result = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'llm_credentials'`
    );
    const columns = result.rows.map((r) => r.column_name);

    expect(columns).toContain('sealed_value');
    expect(columns).not.toContain('value');
    expect(columns).not.toContain('plaintext');
  });

  it('llm_router_tokens_subject_check rejects a run token without a run_id', async () => {
    await expect(
      pg.exec(
        `INSERT INTO llm_router_tokens (token_hash, subject_type, expires_at)
         VALUES ('deadbeef', 'run', now() + interval '30 minutes')`
      )
    ).rejects.toThrow();
  });

  it('llm_providers_protocol_check rejects an unknown protocol', async () => {
    await expect(
      pg.exec(
        `INSERT INTO llm_providers (name, protocol, base_url)
         VALUES ('bedrock', 'aws-bedrock', 'https://bedrock.example.com')`
      )
    ).rejects.toThrow();
  });

  it('the budget unique indexes are NULLS NOT DISTINCT', async () => {
    const result = await pg.query<{ indexname: string; nulls_not_distinct: boolean }>(
      `SELECT c.relname AS indexname, i.indnullsnotdistinct AS nulls_not_distinct
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname IN ('llm_budgets_subject_window_idx', 'llm_budget_usage_subject_window_uniq')
       ORDER BY c.relname`
    );

    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.nulls_not_distinct).toBe(true);
    }
  });

  it('so a second global/day budget collides instead of silently duplicating', async () => {
    await pg.exec(
      `INSERT INTO llm_budgets (subject_type, subject_id, "window", limit_usd)
       VALUES ('global', NULL, 'day', 100)`
    );

    await expect(
      pg.exec(
        `INSERT INTO llm_budgets (subject_type, subject_id, "window", limit_usd)
         VALUES ('global', NULL, 'day', 250)`
      )
    ).rejects.toThrow();

    const rows = await pg.query(`SELECT id FROM llm_budgets WHERE subject_type = 'global'`);
    expect(rows.rows).toHaveLength(1);
  });

  it('llm_calls indexes cover the run / project / session / status drill-downs', async () => {
    const result = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'llm_calls'`
    );
    const byName = new Map(result.rows.map((r) => [r.indexname, r.indexdef]));

    // 断到列上——只断名字的话，把 llm_calls_run_idx 建到 cc_agent_id 上也能绿。
    expect(byName.get('llm_calls_run_idx')).toMatch(/\(run_id, started_at\)/);
    expect(byName.get('llm_calls_project_started_idx')).toMatch(/\(project_id, started_at\)/);
    expect(byName.get('llm_calls_session_idx')).toMatch(/\(cc_session_id\)/);
    expect(byName.get('llm_calls_status_idx')).toMatch(/\(status, started_at\)/);
    // 覆盖 token_id 外键，避免删 run 级联时对本表做全表扫描
    expect(byName.get('llm_calls_token_idx')).toMatch(/\(token_id\)/);
  });

  it('llm_router_tokens indexes cover both cascading foreign keys', async () => {
    const result = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'llm_router_tokens'`
    );
    const byName = new Map(result.rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName.get('llm_router_tokens_run_idx')).toMatch(/\(run_id\)/);
    expect(byName.get('llm_router_tokens_project_idx')).toMatch(/\(project_id\)/);
  });

  it('llm_router_tokens active index keeps the revoked_at IS NULL predicate', async () => {
    const result = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'llm_router_tokens'`
    );
    const active = result.rows.find((r) => r.indexname === 'llm_router_tokens_active_idx');

    expect(active).toBeDefined();
    expect(active?.indexdef).toMatch(/revoked_at IS NULL/i);
  });
});
