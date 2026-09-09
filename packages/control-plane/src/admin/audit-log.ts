export type AuditAction =
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'project.restore'
  | 'member.add'
  | 'member.remove'
  | 'member.role_change'
  | 'agent.create'
  | 'agent.update'
  | 'agent.delete'
  | 'vault.store'
  | 'vault.retrieve'
  | 'vault.remove'
  | 'skill.install'
  | 'skill.uninstall'
  | 'mcp.add'
  | 'mcp.remove'
  | 'run.create'
  | 'run.complete'
  | 'run.fail'
  | 'version.create'
  | 'version.publish'
  | 'deploy.execute'
  // —— llm-router（M6·T6.5）——
  // 凭据的两条都不记录任何密文或明文，只记 credentialId + 操作者；
  // `llm.token.revoke` 记的是 run 级令牌的吊销，是 A9「吊销可审计」那一条。
  | 'llm.credential.store'
  | 'llm.credential.rotate'
  | 'llm.token.revoke';

export interface AuditLogEntry {
  id: string;
  action: AuditAction;
  actorId: string;
  projectId: string | null;
  targetId: string | null;
  targetType: string | null;
  metadata: Record<string, unknown>;
  timestamp: Date;
  ipAddress: string | null;
}

export interface AuditLogStore {
  insert(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<AuditLogEntry>;
  query(filter: AuditLogFilter): Promise<AuditLogEntry[]>;
}

export interface AuditLogFilter {
  projectId?: string;
  actorId?: string;
  action?: AuditAction;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

export class AuditLogger {
  constructor(private store: AuditLogStore) {}

  async log(
    action: AuditAction,
    actorId: string,
    options: {
      projectId?: string;
      targetId?: string;
      targetType?: string;
      metadata?: Record<string, unknown>;
      ipAddress?: string;
    } = {}
  ): Promise<AuditLogEntry> {
    return this.store.insert({
      action,
      actorId,
      projectId: options.projectId ?? null,
      targetId: options.targetId ?? null,
      targetType: options.targetType ?? null,
      metadata: options.metadata ?? {},
      ipAddress: options.ipAddress ?? null,
    });
  }

  async query(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    return this.store.query(filter);
  }
}
