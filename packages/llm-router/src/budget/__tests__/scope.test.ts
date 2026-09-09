/**
 * 作用域解析顺序（M5·T5.2）。归属来自令牌（D6），所以作用域也只能来自令牌。
 */
import { describe, expect, it } from 'vitest';
import type { Subject } from '../../auth/token-store.js';
import { resolveScopes, scopeKey } from '../scope.js';

function subject(over: Partial<Subject> = {}): Subject {
  return {
    tokenId: 'tok-1',
    subjectType: 'run',
    runId: 'run-1',
    agentId: 'agent-1',
    projectId: 'proj-1',
    ownerUserId: 'user-1',
    allowedModelAliases: [],
    maxCostUsd: null,
    maxRequestsPerMinute: null,
    ...over,
  };
}

describe('resolveScopes', () => {
  it('四档齐全时按 agent → project → user → global 排', () => {
    expect(resolveScopes(subject())).toEqual([
      { subjectType: 'agent', subjectId: 'agent-1' },
      { subjectType: 'project', subjectId: 'proj-1' },
      { subjectType: 'user', subjectId: 'user-1' },
      { subjectType: 'global', subjectId: null },
    ]);
  });

  it('归属列为空的档直接跳过', () => {
    expect(resolveScopes(subject({ agentId: null, ownerUserId: null }))).toEqual([
      { subjectType: 'project', subjectId: 'proj-1' },
      { subjectType: 'global', subjectId: null },
    ]);
  });

  it('全空的服务令牌只剩 global', () => {
    const svc = subject({
      subjectType: 'service',
      runId: null,
      agentId: null,
      projectId: null,
      ownerUserId: null,
    });
    expect(resolveScopes(svc)).toEqual([{ subjectType: 'global', subjectId: null }]);
  });
});

describe('scopeKey', () => {
  it('global 的 null id 也有稳定的键', () => {
    expect(scopeKey({ subjectType: 'global', subjectId: null })).toBe('global:');
    expect(scopeKey({ subjectType: 'project', subjectId: 'p1' })).toBe('project:p1');
  });
});
