/**
 * AuditLogger 单测（M6·T6.5 补了三个 llm-router 相关的 action）。
 *
 * `AuditAction` 是纯类型，运行时挡不住任何东西——所以这里用「把三个新值真的写
 * 一遍」来钉住它们：谁把某一行从联合类型里删掉，`pnpm check` 会在这个文件红。
 */
import { describe, expect, it } from 'vitest';
import {
  type AuditAction,
  type AuditLogEntry,
  type AuditLogFilter,
  AuditLogger,
  type AuditLogStore,
} from '../admin/audit-log.js';

class MemoryAuditStore implements AuditLogStore {
  entries: AuditLogEntry[] = [];

  async insert(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<AuditLogEntry> {
    const full: AuditLogEntry = {
      ...entry,
      id: `audit-${this.entries.length + 1}`,
      timestamp: new Date(),
    };
    this.entries.push(full);
    return full;
  }

  async query(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    return this.entries.filter((e) => !filter.action || e.action === filter.action);
  }
}

/** M6·T6.5 追加的三个。 */
const LLM_ACTIONS: AuditAction[] = [
  'llm.credential.store',
  'llm.credential.rotate',
  'llm.token.revoke',
];

describe('AuditLogger', () => {
  it('log 填充默认值并回传完整条目', async () => {
    const store = new MemoryAuditStore();
    const entry = await new AuditLogger(store).log('project.create', 'user-1');

    expect(entry).toMatchObject({
      action: 'project.create',
      actorId: 'user-1',
      projectId: null,
      targetId: null,
      targetType: null,
      metadata: {},
      ipAddress: null,
    });
    expect(entry.id).toBeTruthy();
  });

  it('可选字段原样透传', async () => {
    const store = new MemoryAuditStore();
    const entry = await new AuditLogger(store).log('vault.store', 'user-1', {
      projectId: 'proj-1',
      targetId: 'entry-1',
      targetType: 'vault_entry',
      metadata: { scope: 'project' },
      ipAddress: '10.0.0.1',
    });

    expect(entry).toMatchObject({
      projectId: 'proj-1',
      targetId: 'entry-1',
      targetType: 'vault_entry',
      metadata: { scope: 'project' },
      ipAddress: '10.0.0.1',
    });
  });

  it.each(LLM_ACTIONS)('%s 是合法的 AuditAction 且能落库', async (action) => {
    const store = new MemoryAuditStore();
    const entry = await new AuditLogger(store).log(action, 'user-1', {
      targetId: 'cred-1',
      targetType: 'llm_credential',
    });
    expect(entry.action).toBe(action);
    expect(await new AuditLogger(store).query({ action })).toHaveLength(1);
  });

  it('凭据类审计只记 id，不记任何密文或明文（盲写不变量的审计面）', async () => {
    const store = new MemoryAuditStore();
    await new AuditLogger(store).log('llm.credential.rotate', 'user-1', {
      targetId: 'cred-1',
      targetType: 'llm_credential',
      metadata: { version: 2 },
    });
    const serialized = JSON.stringify(store.entries);
    expect(serialized).toContain('cred-1');
    expect(serialized).not.toMatch(/sealed|sk-ant-/i);
  });

  it('query 的 action 过滤生效', async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);
    await logger.log('llm.token.revoke', 'user-1');
    await logger.log('run.create', 'user-1');
    expect(await logger.query({ action: 'llm.token.revoke' })).toHaveLength(1);
  });
});
