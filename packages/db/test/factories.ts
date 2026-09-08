import { randomUUID } from 'node:crypto';
import {
  agents,
  llmCredentials,
  llmModels,
  llmProviders,
  projectMembers,
  projects,
  runEvents,
  runs,
  tasks,
  users,
} from '../src/schema/index.js';
import type { TestDb } from './pglite-helpers.js';

export async function createTestUser(db: TestDb, overrides?: { name?: string; email?: string }) {
  const [user] = await db
    .insert(users)
    .values({
      name: overrides?.name ?? 'Test User',
      email: overrides?.email ?? `test-${Date.now()}@example.com`,
    })
    .returning();
  return user;
}

export async function createTestProject(
  db: TestDb,
  createdBy: string,
  overrides?: { name?: string; description?: string }
) {
  const [project] = await db
    .insert(projects)
    .values({
      name: overrides?.name ?? 'Test Project',
      description: overrides?.description ?? 'A test project',
      createdBy,
    })
    .returning();
  return project;
}

export async function createTestMember(
  db: TestDb,
  projectId: string,
  userId: string,
  role: string = 'member'
) {
  const [member] = await db.insert(projectMembers).values({ projectId, userId, role }).returning();
  return member;
}

export async function createTestAgent(db: TestDb, projectId: string, createdBy?: string) {
  const [agent] = await db
    .insert(agents)
    .values({
      projectId,
      createdBy,
    })
    .returning();
  return agent;
}

export async function createTestTask(
  db: TestDb,
  projectId: string,
  createdBy: string,
  overrides?: { agentId?: string; title?: string }
) {
  const [task] = await db
    .insert(tasks)
    .values({
      projectId,
      createdBy,
      agentId: overrides?.agentId ?? null,
      title: overrides?.title ?? 'Test Task',
    })
    .returning();
  return task;
}

export async function createTestRun(
  db: TestDb,
  agentId: string,
  overrides?: { prompt?: string; taskId?: string | null; conversationId?: string | null }
) {
  const [run] = await db
    .insert(runs)
    .values({
      agentId,
      prompt: overrides?.prompt ?? 'Test prompt',
      taskId: overrides?.taskId ?? null,
      conversationId: overrides?.conversationId ?? null,
    })
    .returning();
  return run;
}

export async function createTestRunEvent(
  db: TestDb,
  runId: string,
  seq: number,
  overrides?: { eventType?: string; payload?: unknown }
) {
  const [event] = await db
    .insert(runEvents)
    .values({
      runId,
      seq,
      eventType: overrides?.eventType ?? 'message',
      payload: overrides?.payload ?? { text: 'hello' },
    })
    .returning();
  return event;
}

// ---------------------------------------------------------------------------
// llm-router（specs/llm-router.md）
// ---------------------------------------------------------------------------

/**
 * 一条盲写凭据。`sealedValue` 在测试里是任意 base64——本层不解封，
 * 解封只发生在 llm-router 进程内（M2）。
 */
export async function createTestLlmCredential(
  db: TestDb,
  overrides?: { name?: string; keyId?: string; createdBy?: string | null }
) {
  const [credential] = await db
    .insert(llmCredentials)
    .values({
      name: overrides?.name ?? `cred-${randomUUID().slice(0, 8)}`,
      keyId: overrides?.keyId ?? 'a'.repeat(32),
      sealedValue: Buffer.from(`sealed-${randomUUID()}`).toString('base64'),
      createdBy: overrides?.createdBy ?? null,
    })
    .returning();
  return credential;
}

export async function createTestLlmProvider(
  db: TestDb,
  overrides?: {
    name?: string;
    protocol?: 'anthropic' | 'openai';
    baseUrl?: string;
    credentialId?: string | null;
    enabled?: boolean;
  }
) {
  const [provider] = await db
    .insert(llmProviders)
    .values({
      name: overrides?.name ?? `provider-${randomUUID().slice(0, 8)}`,
      protocol: overrides?.protocol ?? 'anthropic',
      baseUrl: overrides?.baseUrl ?? 'https://api.anthropic.com',
      credentialId: overrides?.credentialId ?? null,
      enabled: overrides?.enabled ?? true,
    })
    .returning();
  return provider;
}

/** 默认 `alias === upstreamModel`，即 D2b 的字节级零改写（passthrough）。 */
export async function createTestLlmModel(
  db: TestDb,
  providerId: string,
  overrides?: {
    alias?: string;
    upstreamModel?: string;
    priority?: number;
    enabled?: boolean;
    priceInputPerMtok?: string;
    priceOutputPerMtok?: string;
  }
) {
  const alias = overrides?.alias ?? 'claude-opus-4';
  const [model] = await db
    .insert(llmModels)
    .values({
      alias,
      providerId,
      upstreamModel: overrides?.upstreamModel ?? alias,
      priority: overrides?.priority ?? 0,
      enabled: overrides?.enabled ?? true,
      priceInputPerMtok: overrides?.priceInputPerMtok ?? '0',
      priceOutputPerMtok: overrides?.priceOutputPerMtok ?? '0',
    })
    .returning();
  return model;
}
