/**
 * 验收环境的数据种子（M7·T7.1）。
 *
 * 一次 `seedAcceptanceFixture()` 把 A1–A11 需要的全部前置状态铺好：一条链路上的
 * user / project / agent / run（`llm_router_tokens.run_id` 有外键，绕不过去），
 * 一条盲写凭据，两个 provider（Anthropic 面与 OpenAI 面各一个，都指向假上游），
 * 12 条模型目录（A4 要的 disabled / 并列 priority / 跨 provider 同名 alias 都在里面），
 * 以及一枚 per-run 令牌。
 *
 * **凭据是用 `seal()` 写进去的**，与 apps/web 的录入路径同一个函数——验收不能
 * 自己造一条「测试专用的明文凭据」，那样 A11 就变成了自证一个不存在的系统。
 */
import { randomUUID } from 'node:crypto';
import {
  agents,
  type getDbClient,
  llmCredentials,
  llmModels,
  llmProviders,
  llmRouterTokens,
  projects,
  runs,
  users,
} from '@open-rush/db';
import { seal } from '@open-rush/llm-router/sealing';
import { mintRouterToken } from '@open-rush/llm-router/token';
import { eq, inArray, like } from 'drizzle-orm';

type Db = ReturnType<typeof getDbClient>;

/** 所有验收数据都带这个前缀，`cleanup()` 据此精确清场，不碰别人的数据。 */
export const ACCEPTANCE_PREFIX = 'acc-';

/**
 * 目录 fixture。alias 的命名规则本身就是 A4 的期望表：
 * `acc-passthrough` 走 Anthropic 上游且 alias == upstreamModel（字节级零改写），
 * `acc-rewrite` 异名（只改 `$.model`），`acc-openai-*` 落在 OpenAI 上游。
 */
export interface SeededModel {
  alias: string;
  provider: 'anthropic' | 'openai' | 'dead';
  upstreamModel: string;
  priority: number;
  enabled: boolean;
}

export const SEEDED_MODELS: readonly SeededModel[] = [
  // ① passthrough：alias 与上游模型名同名 → 请求体一个字节都不该动
  {
    alias: 'acc-passthrough',
    provider: 'anthropic',
    upstreamModel: 'acc-passthrough',
    priority: 0,
    enabled: true,
  },
  // ② rewrite-model：异名 → 只允许改 $.model 一个字段
  {
    alias: 'acc-rewrite',
    provider: 'anthropic',
    upstreamModel: 'fake-anthropic-upstream',
    priority: 0,
    enabled: true,
  },
  // ③ OpenAI 上游：同协议面走 passthrough，Anthropic 面打它则走 translate
  {
    alias: 'acc-openai',
    provider: 'openai',
    upstreamModel: 'acc-openai',
    priority: 0,
    enabled: true,
  },
  {
    alias: 'acc-openai-rewrite',
    provider: 'openai',
    upstreamModel: 'fake-openai-upstream',
    priority: 0,
    enabled: true,
  },
  // ④ 并列 priority：同 alias 两条候选，按 (priority, id) 排序取第一条
  { alias: 'acc-tied', provider: 'anthropic', upstreamModel: 'tied-a', priority: 5, enabled: true },
  { alias: 'acc-tied', provider: 'openai', upstreamModel: 'tied-b', priority: 5, enabled: true },
  // ⑤ 跨 provider 同名 alias 且 priority 有高下：低 priority 胜出
  { alias: 'acc-priority', provider: 'openai', upstreamModel: 'loser', priority: 9, enabled: true },
  {
    alias: 'acc-priority',
    provider: 'anthropic',
    upstreamModel: 'winner',
    priority: 1,
    enabled: true,
  },
  // ⑥ disabled：不该被路由到（等价于不存在 → 404）
  {
    alias: 'acc-disabled',
    provider: 'anthropic',
    upstreamModel: 'never',
    priority: 0,
    enabled: false,
  },
  // ⑦ 只有 disabled 候选的 alias：同样 404，且不能泄露它存在过
  {
    alias: 'acc-disabled-only',
    provider: 'openai',
    upstreamModel: 'never2',
    priority: 0,
    enabled: false,
  },
  // ⑧ A10：指向一个没人监听的端口 → ECONNREFUSED
  { alias: 'acc-dead', provider: 'dead', upstreamModel: 'acc-dead', priority: 0, enabled: true },
  // ⑨ 令牌白名单用：token 的 allowedModelAliases 不含它时应 403 而非 404
  {
    alias: 'acc-not-allowed',
    provider: 'anthropic',
    upstreamModel: 'acc-not-allowed',
    priority: 0,
    enabled: true,
  },
];

/** 目录里**不存在**的三个 alias，A4 用它们验 404。 */
export const UNKNOWN_ALIASES = ['acc-nope-1', 'acc-nope-2', 'acc-ghost'] as const;

export interface SeedOptions {
  db: Db;
  /** 假上游的 base URL，例如 `http://127.0.0.1:9999`。 */
  upstreamBaseUrl: string;
  /** 一个确定没人监听的端口，用于 A10 的 ECONNREFUSED。 */
  deadBaseUrl: string;
  publicKeyPem: string;
  /** 供应商真 key 的明文。只在本进程内出现，随后全程以密文形态存在。 */
  providerKey: string;
  /** provider 的上游超时，A10 的 hang 场景靠它收尾。 */
  timeoutMs?: number;
}

export interface SeededFixture {
  userId: string;
  projectId: string;
  agentId: string;
  runId: string;
  credentialId: string;
  providerIds: Record<'anthropic' | 'openai' | 'dead', string>;
  /** alias → model id。同名 alias 只留最后一条，测试不依赖它。 */
  modelIds: Record<string, string>;
  /** per-run 令牌明文。只在这里出现一次。 */
  token: string;
  tokenId: string;
}

export async function seedAcceptanceFixture(opts: SeedOptions): Promise<SeededFixture> {
  const { db } = opts;
  const suffix = randomUUID().slice(0, 8);

  const [user] = await db
    .insert(users)
    .values({ name: 'LLM Router Acceptance', email: `${ACCEPTANCE_PREFIX}${suffix}@rush.dev` })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ name: `${ACCEPTANCE_PREFIX}project-${suffix}`, createdBy: user.id })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      projectId: project.id,
      status: 'active',
      customTitle: 'acceptance',
      createdBy: user.id,
    })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({
      agentId: agent.id,
      prompt: 'acceptance',
      status: 'running',
      provider: 'claude-code',
      connectionMode: 'anthropic',
      triggerSource: 'user',
    })
    .returning();

  // 凭据：走与 apps/web 完全相同的 seal()，库里只落密文。
  const envelope = seal(opts.publicKeyPem, opts.providerKey);
  const [credential] = await db
    .insert(llmCredentials)
    .values({
      name: `${ACCEPTANCE_PREFIX}cred-${suffix}`,
      alg: envelope.alg,
      keyId: envelope.keyId,
      sealedValue: envelope.value,
      authStyle: 'bearer',
      createdBy: user.id,
    })
    .returning();

  const timeoutMs = opts.timeoutMs ?? 3_000;
  const providerRows = await db
    .insert(llmProviders)
    .values([
      {
        name: `${ACCEPTANCE_PREFIX}anthropic-${suffix}`,
        protocol: 'anthropic' as const,
        baseUrl: opts.upstreamBaseUrl,
        credentialId: credential.id,
        timeoutMs,
      },
      {
        name: `${ACCEPTANCE_PREFIX}openai-${suffix}`,
        protocol: 'openai' as const,
        baseUrl: opts.upstreamBaseUrl,
        credentialId: credential.id,
        timeoutMs,
      },
      {
        name: `${ACCEPTANCE_PREFIX}dead-${suffix}`,
        protocol: 'anthropic' as const,
        baseUrl: opts.deadBaseUrl,
        credentialId: credential.id,
        timeoutMs,
      },
    ])
    .returning();

  const providerIds = {
    anthropic: providerRows[0].id,
    openai: providerRows[1].id,
    dead: providerRows[2].id,
  };

  const modelRows = await db
    .insert(llmModels)
    .values(
      SEEDED_MODELS.map((m) => ({
        alias: m.alias,
        providerId: providerIds[m.provider],
        upstreamModel: m.upstreamModel,
        priority: m.priority,
        enabled: m.enabled,
        // 定价刻意取好算的整数：1000 tok = $1，方便 A5 手算对账。
        priceInputPerMtok: '1000.000000',
        priceOutputPerMtok: '2000.000000',
        priceCacheWritePerMtok: '1250.000000',
        priceCacheReadPerMtok: '100.000000',
        priceReasoningPerMtok: '2000.000000',
      }))
    )
    .returning();

  const modelIds: Record<string, string> = {};
  for (const row of modelRows) modelIds[row.alias] = row.id;

  const { plaintext, tokenHash } = mintRouterToken();
  const [tokenRow] = await db
    .insert(llmRouterTokens)
    .values({
      tokenHash,
      subjectType: 'run',
      runId: run.id,
      agentId: agent.id,
      projectId: project.id,
      ownerUserId: user.id,
      // 空白名单 = 放行一切。`acc-not-allowed` 的 403 用另一枚受限令牌验（见 mintRestrictedToken）。
      allowedModelAliases: [],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();

  return {
    userId: user.id,
    projectId: project.id,
    agentId: agent.id,
    runId: run.id,
    credentialId: credential.id,
    providerIds,
    modelIds,
    token: plaintext,
    tokenId: tokenRow.id,
  };
}

/** 再签一枚白名单受限的令牌，用于验「令牌不允许的 alias 回 403 而不是 404」。 */
export async function mintRestrictedToken(
  db: Db,
  fixture: SeededFixture,
  allowed: string[]
): Promise<{ token: string; tokenId: string }> {
  const { plaintext, tokenHash } = mintRouterToken();
  const [row] = await db
    .insert(llmRouterTokens)
    .values({
      tokenHash,
      subjectType: 'run',
      runId: fixture.runId,
      agentId: fixture.agentId,
      projectId: fixture.projectId,
      ownerUserId: fixture.userId,
      allowedModelAliases: allowed,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  return { token: plaintext, tokenId: row.id };
}

/**
 * 清场。顺序按外键反向来：模型 → provider → 凭据，用户那条 cascade 会带走
 * project / agent / run / token / llm_calls。
 */
export async function cleanupAcceptanceFixture(db: Db, fixture: SeededFixture): Promise<void> {
  await db
    .delete(llmModels)
    .where(inArray(llmModels.providerId, Object.values(fixture.providerIds)));
  await db.delete(llmProviders).where(inArray(llmProviders.id, Object.values(fixture.providerIds)));
  await db.delete(llmCredentials).where(eq(llmCredentials.id, fixture.credentialId));
  await db.delete(users).where(eq(users.id, fixture.userId));
}

/** 兜底清场：上一轮验收被 Ctrl-C 打断时用。 */
export async function cleanupStaleFixtures(db: Db): Promise<void> {
  const providers = await db
    .select({ id: llmProviders.id })
    .from(llmProviders)
    .where(like(llmProviders.name, `${ACCEPTANCE_PREFIX}%`));
  const providerIds = providers.map((p) => p.id);
  if (providerIds.length > 0) {
    await db.delete(llmModels).where(inArray(llmModels.providerId, providerIds));
    await db.delete(llmProviders).where(inArray(llmProviders.id, providerIds));
  }
  await db.delete(llmCredentials).where(like(llmCredentials.name, `${ACCEPTANCE_PREFIX}%`));
  await db.delete(users).where(like(users.email, `${ACCEPTANCE_PREFIX}%`));
}
