/**
 * AgentExecutor 单测（M6·T6.2）。
 *
 * 重点是 `modelAlias` 的解析链——`ref/R1` §2.6 的断链就断在这里：`agents.model`
 * 列一直存在，但既没被读出来、也没被传下去，于是 per-agent 模型选择实际不生效。
 */
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../agent/agent-config.js';
import {
  AgentExecutor,
  type AgentExecutorDeps,
  DEFAULT_MODEL_ALIAS,
  resolveModelAlias,
} from '../run/agent-executor.js';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    projectId: 'proj-1',
    name: 'web-builder',
    scope: 'project',
    status: 'active',
    systemPrompt: null,
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

function makeExecutor(
  agent: AgentConfig,
  overrides: Partial<AgentExecutorDeps> = {}
): AgentExecutor {
  return new AgentExecutor({
    resolveAgent: async () => agent,
    resolveVaultEnv: async () => ({}),
    resolveSkills: async () => [],
    resolveMcpServers: async () => [],
    ...overrides,
  });
}

describe('resolveModelAlias', () => {
  it('agents.model 优先', () => {
    expect(resolveModelAlias('glm-4.7', 'sonnet-default')).toBe('glm-4.7');
  });

  it('agents.model 为 null → 回落到默认值', () => {
    expect(resolveModelAlias(null, 'sonnet-default')).toBe('sonnet-default');
  });

  it('agents.model 为空白串等同于未配置——UI 清空输入框留下的常是 "" 而非 NULL', () => {
    expect(resolveModelAlias('   ', 'sonnet-default')).toBe('sonnet-default');
    expect(resolveModelAlias('', 'sonnet-default')).toBe('sonnet-default');
  });

  it('默认值也是空白串 → 回落到全局缺省', () => {
    expect(resolveModelAlias(null, '  ')).toBe(DEFAULT_MODEL_ALIAS);
    expect(resolveModelAlias(undefined, undefined)).toBe(DEFAULT_MODEL_ALIAS);
  });

  it('两侧都配了也只取 agent 那一个，且去掉首尾空白', () => {
    expect(resolveModelAlias(' opus ', 'sonnet')).toBe('opus');
  });
});

describe('prepareContext', () => {
  it('把 agents.model 解析进 modelAlias（修 R1 §2.6 的断链）', async () => {
    const ctx = await makeExecutor(makeAgent({ model: 'glm-4.7' })).prepareContext(
      'agent-1',
      'proj-1'
    );
    expect(ctx.modelAlias).toBe('glm-4.7');
  });

  it('agent 没配 model 时用 defaultModelAlias', async () => {
    const ctx = await makeExecutor(makeAgent({ model: null }), {
      defaultModelAlias: 'router-default',
    }).prepareContext('agent-1', 'proj-1');
    expect(ctx.modelAlias).toBe('router-default');
  });

  it('两边都没配时是全局缺省——modelAlias 永远非空（它同时是令牌白名单里那一个值）', async () => {
    const ctx = await makeExecutor(makeAgent()).prepareContext('agent-1', 'proj-1');
    expect(ctx.modelAlias).toBe(DEFAULT_MODEL_ALIAS);
    expect(ctx.modelAlias.length).toBeGreaterThan(0);
  });

  it('其余字段照旧：env / skills / mcp 的过滤逻辑没被改动', async () => {
    const executor = makeExecutor(makeAgent({ skills: ['a'], mcpServers: ['m1'] }), {
      resolveVaultEnv: async () => ({ FOO: 'bar' }),
      resolveSkills: async () => ['a', 'b'],
      resolveMcpServers: async () => ['m1', 'm2'],
    });
    const ctx = await executor.prepareContext('agent-1', 'proj-1');
    expect(ctx.env).toEqual({ FOO: 'bar' });
    expect(ctx.skills).toEqual(['a']);
    expect(ctx.mcpServers).toEqual(['m1']);
  });

  it('agent 不存在时抛', async () => {
    const executor = makeExecutor(makeAgent(), { resolveAgent: async () => null });
    await expect(executor.prepareContext('nope', 'proj-1')).rejects.toThrow(
      "Agent 'nope' not found"
    );
  });
});
