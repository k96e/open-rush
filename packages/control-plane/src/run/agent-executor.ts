import type { AgentConfig } from '../agent/agent-config.js';

/**
 * 所有解析路径都失败时的兜底 alias。
 *
 * 取 `'sonnet'` 是为了与 `apps/agent-worker/src/server.ts` 改造前的兜底一致——
 * 那里写的就是 `modelId ?? CLAUDE_MODEL ?? ANTHROPIC_MODEL ?? 'sonnet'`。
 * 接上网关之后这个值同时也是签发令牌时的 alias 白名单，所以部署方若改了目录里
 * 的 alias 命名，要么给 agent 配上 `agents.model`，要么设 `LLM_ROUTER_DEFAULT_MODEL`。
 */
export const DEFAULT_MODEL_ALIAS = 'sonnet';

export interface AgentContext {
  agentConfig: AgentConfig;
  projectId: string;
  env: Record<string, string>;
  /**
   * 解析后的模型 alias：`agentConfig.model` → `defaultModelAlias` →
   * {@link DEFAULT_MODEL_ALIAS}。**永远非空**，因为它同时是签发令牌时写进
   * `allowed_model_aliases` 的那一个值（M6·T6.2）。
   */
  modelAlias: string;
  skills: string[];
  mcpServers: string[];
}

export interface AgentExecutorDeps {
  resolveAgent(agentId: string, projectId: string): Promise<AgentConfig | null>;
  resolveVaultEnv(projectId: string): Promise<Record<string, string>>;
  resolveSkills(projectId: string): Promise<string[]>;
  resolveMcpServers(projectId: string): Promise<string[]>;
  /** `agents.model` 为空时的回落值，通常来自 `LLM_ROUTER_DEFAULT_MODEL`。 */
  defaultModelAlias?: string;
}

export class AgentExecutor {
  constructor(private deps: AgentExecutorDeps) {}

  async prepareContext(agentId: string, projectId: string): Promise<AgentContext> {
    const agentConfig = await this.deps.resolveAgent(agentId, projectId);
    if (!agentConfig) throw new Error(`Agent '${agentId}' not found`);

    const [env, skills, mcpServers] = await Promise.all([
      this.deps.resolveVaultEnv(projectId),
      this.deps.resolveSkills(projectId),
      this.deps.resolveMcpServers(projectId),
    ]);

    const filteredSkills = agentConfig.skills?.length
      ? skills.filter((s) => agentConfig.skills?.includes(s))
      : skills;

    const filteredMcp = agentConfig.mcpServers?.length
      ? mcpServers.filter((s) => agentConfig.mcpServers?.includes(s))
      : mcpServers;

    return {
      agentConfig,
      projectId,
      env,
      modelAlias: resolveModelAlias(agentConfig.model, this.deps.defaultModelAlias),
      skills: filteredSkills,
      mcpServers: filteredMcp,
    };
  }
}

/**
 * 逐级回落，空白串等同于未配置——`agents.model` 是可空 varchar，UI 上清空一个
 * 输入框留下的往往是 `''` 而不是 NULL，那种值传给网关会直接 404。
 */
export function resolveModelAlias(
  agentModel: string | null | undefined,
  defaultAlias: string | undefined
): string {
  return agentModel?.trim() || defaultAlias?.trim() || DEFAULT_MODEL_ALIAS;
}
