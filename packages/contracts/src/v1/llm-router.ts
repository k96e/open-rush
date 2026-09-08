/**
 * /api/v1/llm/* — LLM Router 控制台契约。
 *
 * See specs/llm-router.md（落位 / 协议承诺分层 / 密钥边界 / 错误信封三分法）。
 *
 * 资源：
 * - credentials — 供应商密钥（**录入即盲写**，见下方 A11 闸门说明）
 * - providers   — 供应商（协议 + baseUrl + 凭据引用）
 * - models      — 模型别名 → 上游模型的目录项 + 价目
 * - calls       — 逐调用计量明细（只读）
 *
 * ⚠️ 本文件是密钥边界的**第一道闸门**：`llmCredentialSchema` 结构上不含
 * `sealedValue` / `value`，任何回显密文/明文的实现都会在契约层被挡下。
 */
import { z } from 'zod';
import { paginatedResponseSchema, paginationQuerySchema, successResponseSchema } from './common.js';

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/** 协议族：调用方协议面与上游协议都用这一套值。 */
export const llmProtocolSchema = z.enum(['anthropic', 'openai']);
export type LlmProtocol = z.infer<typeof llmProtocolSchema>;

/**
 * 路由模式（specs/llm-router.md §协议承诺分层）：
 * - `passthrough`    同协议 + 同名 → 请求/响应 body 逐字节一致
 * - `rewrite-model`  同协议 + 异名 → 只改 `$.model` 一个字段
 * - `translate`      跨协议 → 不承诺零改写，只承诺语义等价
 */
export const llmRouteModeSchema = z.enum(['passthrough', 'rewrite-model', 'translate']);
export type LlmRouteMode = z.infer<typeof llmRouteModeSchema>;

/**
 * 上游认证方式：
 * - `bearer`    → `Authorization: Bearer <key>`
 * - `x-api-key` → `x-api-key: <key>`
 * - `header`    → 用 `authHeader` 指定的头承载
 */
export const llmAuthStyleSchema = z.enum(['bearer', 'x-api-key', 'header']);
export type LlmAuthStyle = z.infer<typeof llmAuthStyleSchema>;

/** 计量记录的归属类型（D6：令牌即归属）。 */
export const llmCallSubjectTypeSchema = z.enum(['run', 'service']);
export type LlmCallSubjectType = z.infer<typeof llmCallSubjectTypeSchema>;

/** 逐调用终态。与 specs/llm-router.md §错误信封三分法 的码位表一一对应。 */
export const llmCallStatusSchema = z.enum([
  'success',
  'upstream_error',
  'rate_limited',
  'budget_exceeded',
  'client_abort',
  'router_error',
  'unauthorized',
  'forbidden',
  'model_not_found',
]);
export type LlmCallStatus = z.infer<typeof llmCallStatusSchema>;

/** 预算档位：`observe` 只记不拦，`enforce` 超限即 429。 */
export const llmBudgetModeSchema = z.enum(['observe', 'enforce']);
export type LlmBudgetMode = z.infer<typeof llmBudgetModeSchema>;

// ---------------------------------------------------------------------------
// 共用片段
// ---------------------------------------------------------------------------

/** numeric 列经 drizzle 映射为 string；用十进制字符串表达，避免浮点误差。 */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal number string');

/**
 * Boolean-from-string helper for query params。与 agent-definitions.ts 同款：
 * 不用 `z.coerce.boolean`——那会把字符串 `"false"` 当真值，静默翻转过滤条件。
 */
const queryBoolean = z
  .union([z.literal('true'), z.literal('false'), z.boolean()])
  .transform((v) => v === true || v === 'true');

/** 凭据/供应商/模型别名的人类可读标识（小写 kebab）。 */
const slug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase alphanumeric with dashes');

// ---------------------------------------------------------------------------
// POST /api/v1/llm/credentials — 录入即盲写
// ---------------------------------------------------------------------------

/**
 * 录入凭据。`value` 是明文供应商 key，服务端立刻用 `LLM_ROUTER_PUBLIC_KEY`
 * seal 后丢弃——永不落库明文、永不回显、永不进日志（盲写不变量 1–3）。
 */
export const createLlmCredentialRequestSchema = z
  .object({
    name: slug,
    /** 明文，仅在这一次请求里存在。 */
    value: z.string().min(8).max(8192),
    authStyle: llmAuthStyleSchema.default('bearer'),
    authHeader: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.authStyle !== 'header' || !!v.authHeader, {
    message: 'authHeader is required when authStyle="header"',
    path: ['authHeader'],
  });
export type CreateLlmCredentialRequest = z.infer<typeof createLlmCredentialRequestSchema>;

/**
 * 凭据的对外形状。
 *
 * **结构上不含 `sealedValue` / `value`** —— 这是密钥边界的第一道闸门，
 * 对应单测 llm-router.test.ts 里的显式断言。
 */
export const llmCredentialSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** 封装算法标识，当前唯一合法值 'x25519-hkdf-sha256-aes256gcm'。 */
  alg: z.string(),
  /** 收件公钥指纹，router 启动时比对，指纹不符即拒绝解封。 */
  keyId: z.string(),
  authStyle: llmAuthStyleSchema,
  authHeader: z.string().nullable(),
  /** 轮换计数，从 1 开始。 */
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  rotatedAt: z.string().datetime({ offset: true }).nullable(),
});
export type LlmCredential = z.infer<typeof llmCredentialSchema>;

export const createLlmCredentialResponseSchema = successResponseSchema(llmCredentialSchema);
export type CreateLlmCredentialResponse = z.infer<typeof createLlmCredentialResponseSchema>;

export const listLlmCredentialsQuerySchema = paginationQuerySchema;
export type ListLlmCredentialsQuery = z.infer<typeof listLlmCredentialsQuerySchema>;

export const listLlmCredentialsResponseSchema = paginatedResponseSchema(llmCredentialSchema);
export type ListLlmCredentialsResponse = z.infer<typeof listLlmCredentialsResponseSchema>;

/** POST /api/v1/llm/credentials/:id/rotate — 覆盖密文、version++、不保留历史密文。 */
export const rotateLlmCredentialRequestSchema = z.object({
  value: z.string().min(8).max(8192),
});
export type RotateLlmCredentialRequest = z.infer<typeof rotateLlmCredentialRequestSchema>;

export const rotateLlmCredentialResponseSchema = successResponseSchema(llmCredentialSchema);
export type RotateLlmCredentialResponse = z.infer<typeof rotateLlmCredentialResponseSchema>;

export const llmResourceParamsSchema = z.object({ id: z.string().uuid() });
export type LlmResourceParams = z.infer<typeof llmResourceParamsSchema>;

export const deleteLlmCredentialResponseSchema = successResponseSchema(
  z.object({ id: z.string().uuid(), deleted: z.literal(true) })
);
export type DeleteLlmCredentialResponse = z.infer<typeof deleteLlmCredentialResponseSchema>;

// ---------------------------------------------------------------------------
// /api/v1/llm/providers
// ---------------------------------------------------------------------------

export const llmProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  protocol: llmProtocolSchema,
  /** 不含尾斜杠，如 https://api.anthropic.com */
  baseUrl: z.string().url(),
  credentialId: z.string().uuid().nullable(),
  /** 转发时追加到上游请求的固定头。 */
  defaultHeaders: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive(),
  enabled: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type LlmProvider = z.infer<typeof llmProviderSchema>;

export const createLlmProviderRequestSchema = z.object({
  name: slug,
  protocol: llmProtocolSchema,
  baseUrl: z.string().url(),
  credentialId: z.string().uuid().nullable().optional(),
  defaultHeaders: z.record(z.string(), z.string()).default({}),
  /** R4 §5.3：默认 10 分钟——SSE 长流场景下短于 Claude Code 的 300s 字节看门狗会误杀。 */
  timeoutMs: z.number().int().positive().max(600_000).default(600_000),
  enabled: z.boolean().default(true),
});
export type CreateLlmProviderRequest = z.infer<typeof createLlmProviderRequestSchema>;

/** PATCH — 全字段可选，至少给一个（空 patch 是无意义写入，且会白白 bump 目录版本）。 */
export const patchLlmProviderRequestSchema = createLlmProviderRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchLlmProviderRequest = z.infer<typeof patchLlmProviderRequestSchema>;

export const createLlmProviderResponseSchema = successResponseSchema(llmProviderSchema);
export type CreateLlmProviderResponse = z.infer<typeof createLlmProviderResponseSchema>;

export const listLlmProvidersQuerySchema = paginationQuerySchema.extend({
  enabled: queryBoolean.optional(),
});
export type ListLlmProvidersQuery = z.infer<typeof listLlmProvidersQuerySchema>;

export const listLlmProvidersResponseSchema = paginatedResponseSchema(llmProviderSchema);
export type ListLlmProvidersResponse = z.infer<typeof listLlmProvidersResponseSchema>;

// ---------------------------------------------------------------------------
// /api/v1/llm/models
// ---------------------------------------------------------------------------

export const llmModelSchema = z.object({
  id: z.string().uuid(),
  /** 对外模型名。`alias === upstreamModel` 时走 passthrough（零改写）。 */
  alias: z.string(),
  providerId: z.string().uuid(),
  upstreamModel: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  displayName: z.string().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  /** 价目：numeric → string（drizzle numeric 的默认映射），单位 USD / 1M tokens。 */
  priceInputPerMtok: decimalString,
  priceOutputPerMtok: decimalString,
  priceCacheWritePerMtok: decimalString,
  priceCacheReadPerMtok: decimalString,
  priceReasoningPerMtok: decimalString,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type LlmModel = z.infer<typeof llmModelSchema>;

export const createLlmModelRequestSchema = z.object({
  alias: z.string().min(1).max(255),
  providerId: z.string().uuid(),
  upstreamModel: z.string().min(1).max(255),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  displayName: z.string().max(255).nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  priceInputPerMtok: decimalString.default('0'),
  priceOutputPerMtok: decimalString.default('0'),
  priceCacheWritePerMtok: decimalString.default('0'),
  priceCacheReadPerMtok: decimalString.default('0'),
  priceReasoningPerMtok: decimalString.default('0'),
});
export type CreateLlmModelRequest = z.infer<typeof createLlmModelRequestSchema>;

export const patchLlmModelRequestSchema = createLlmModelRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchLlmModelRequest = z.infer<typeof patchLlmModelRequestSchema>;

export const createLlmModelResponseSchema = successResponseSchema(llmModelSchema);
export type CreateLlmModelResponse = z.infer<typeof createLlmModelResponseSchema>;

export const listLlmModelsQuerySchema = paginationQuerySchema.extend({
  providerId: z.string().uuid().optional(),
  enabled: queryBoolean.optional(),
});
export type ListLlmModelsQuery = z.infer<typeof listLlmModelsQuerySchema>;

export const listLlmModelsResponseSchema = paginatedResponseSchema(llmModelSchema);
export type ListLlmModelsResponse = z.infer<typeof listLlmModelsResponseSchema>;

// ---------------------------------------------------------------------------
// /api/v1/llm/budgets
// ---------------------------------------------------------------------------

/**
 * 预算的作用域。解析时按 `agent → project → user → global` 的优先级取最近的一档。
 */
export const llmBudgetSubjectTypeSchema = z.enum(['global', 'project', 'user', 'agent']);
export type LlmBudgetSubjectType = z.infer<typeof llmBudgetSubjectTypeSchema>;

/** 累计窗口。`total` = 不滚动，自建库以来累计。 */
export const llmBudgetWindowSchema = z.enum(['day', 'month', 'total']);
export type LlmBudgetWindow = z.infer<typeof llmBudgetWindowSchema>;

/** `subjectType='global'` 时 `subjectId` 必须为 null；其余三档必须有 id。 */
function hasConsistentBudgetSubject(v: {
  subjectType: LlmBudgetSubjectType;
  subjectId?: string | null;
}): boolean {
  return v.subjectType === 'global' ? v.subjectId == null : v.subjectId != null;
}

const budgetSubjectIssue = {
  message: 'subjectId must be null for subjectType="global" and set otherwise',
  path: ['subjectId'] as (string | number)[],
};

export const llmBudgetSchema = z
  .object({
    id: z.string().uuid(),
    subjectType: llmBudgetSubjectTypeSchema,
    /** global 时为 null；其余为 project / user / agent 的 id。 */
    subjectId: z.string().uuid().nullable(),
    /** `llm_budgets.enforce` 布尔列的 DTO 面：false → observe，true → enforce。 */
    mode: llmBudgetModeSchema,
    window: llmBudgetWindowSchema,
    limitUsd: decimalString,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .refine(hasConsistentBudgetSubject, budgetSubjectIssue);
export type LlmBudget = z.infer<typeof llmBudgetSchema>;

export const putLlmBudgetRequestSchema = z
  .object({
    subjectType: llmBudgetSubjectTypeSchema.default('global'),
    subjectId: z.string().uuid().nullable().default(null),
    mode: llmBudgetModeSchema.default('observe'),
    window: llmBudgetWindowSchema.default('day'),
    limitUsd: decimalString,
  })
  .refine(hasConsistentBudgetSubject, budgetSubjectIssue);
export type PutLlmBudgetRequest = z.infer<typeof putLlmBudgetRequestSchema>;

export const putLlmBudgetResponseSchema = successResponseSchema(llmBudgetSchema);
export type PutLlmBudgetResponse = z.infer<typeof putLlmBudgetResponseSchema>;

export const listLlmBudgetsResponseSchema = paginatedResponseSchema(llmBudgetSchema);
export type ListLlmBudgetsResponse = z.infer<typeof listLlmBudgetsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/v1/llm/calls — 逐调用明细（只读）
// ---------------------------------------------------------------------------

/**
 * 逐调用记录的对外形状。
 *
 * `ccSessionId` / `ccAgentId` 来自 `x-claude-code-*` 头，**只是分组提示**，
 * 不作授权与计费依据（D6：令牌即归属）。
 */
export const llmCallSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().nullable(),
  subjectType: llmCallSubjectTypeSchema,
  runId: z.string().uuid().nullable(),
  agentId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  ownerUserId: z.string().uuid().nullable(),
  ccSessionId: z.string().nullable(),
  ccAgentId: z.string().nullable(),
  modelAlias: z.string(),
  upstreamModel: z.string().nullable(),
  protocol: llmProtocolSchema,
  mode: llmRouteModeSchema,
  stream: z.boolean(),
  status: llmCallStatusSchema,
  httpStatus: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  tokensIn: z.number().int().min(0),
  tokensCacheWrite: z.number().int().min(0),
  tokensCacheRead: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  tokensReasoning: z.number().int().min(0),
  costUsd: decimalString,
  ttfbMs: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type LlmCall = z.infer<typeof llmCallSchema>;

export const listLlmCallsQuerySchema = paginationQuerySchema.extend({
  runId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  status: llmCallStatusSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export type ListLlmCallsQuery = z.infer<typeof listLlmCallsQuerySchema>;

export const listLlmCallsResponseSchema = paginatedResponseSchema(llmCallSchema);
export type ListLlmCallsResponse = z.infer<typeof listLlmCallsResponseSchema>;
