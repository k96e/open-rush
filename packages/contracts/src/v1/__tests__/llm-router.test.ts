import { describe, expect, it } from 'vitest';
import {
  createLlmCredentialRequestSchema,
  createLlmCredentialResponseSchema,
  createLlmModelRequestSchema,
  createLlmModelResponseSchema,
  createLlmProviderRequestSchema,
  createLlmProviderResponseSchema,
  deleteLlmCredentialResponseSchema,
  listLlmBudgetsResponseSchema,
  listLlmCallsQuerySchema,
  listLlmCallsResponseSchema,
  listLlmCredentialsQuerySchema,
  listLlmCredentialsResponseSchema,
  listLlmModelsQuerySchema,
  listLlmModelsResponseSchema,
  listLlmProvidersQuerySchema,
  listLlmProvidersResponseSchema,
  llmAuthStyleSchema,
  llmBudgetModeSchema,
  llmBudgetSchema,
  llmBudgetSubjectTypeSchema,
  llmBudgetWindowSchema,
  llmCallSchema,
  llmCallStatusSchema,
  llmCallSubjectTypeSchema,
  llmCredentialSchema,
  llmModelSchema,
  llmProtocolSchema,
  llmProviderSchema,
  llmResourceParamsSchema,
  llmRouteModeSchema,
  patchLlmModelRequestSchema,
  patchLlmProviderRequestSchema,
  putLlmBudgetRequestSchema,
  putLlmBudgetResponseSchema,
  rotateLlmCredentialRequestSchema,
  rotateLlmCredentialResponseSchema,
} from '../llm-router.js';

const credential = {
  id: '00000000-0000-0000-0000-000000000060',
  name: 'anthropic-prod',
  alg: 'x25519-hkdf-sha256-aes256gcm',
  keyId: 'a'.repeat(32),
  authStyle: 'bearer' as const,
  authHeader: null,
  version: 1,
  createdAt: '2026-04-28T00:00:00Z',
  updatedAt: '2026-04-28T00:00:00Z',
  rotatedAt: null,
};

const provider = {
  id: '00000000-0000-0000-0000-000000000061',
  name: 'anthropic',
  protocol: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  credentialId: '00000000-0000-0000-0000-000000000060',
  defaultHeaders: { 'x-tenant': 'openrush' },
  timeoutMs: 120_000,
  enabled: true,
  createdAt: '2026-04-28T00:00:00Z',
  updatedAt: '2026-04-28T00:00:00Z',
};

const model = {
  id: '00000000-0000-0000-0000-000000000062',
  alias: 'claude-sonnet-4-6',
  providerId: provider.id,
  upstreamModel: 'claude-sonnet-4-6',
  priority: 0,
  enabled: true,
  displayName: 'Sonnet 4.6',
  maxOutputTokens: 64000,
  priceInputPerMtok: '3',
  priceOutputPerMtok: '15',
  priceCacheWritePerMtok: '3.75',
  priceCacheReadPerMtok: '0.30',
  priceReasoningPerMtok: '0',
  createdAt: '2026-04-28T00:00:00Z',
  updatedAt: '2026-04-28T00:00:00Z',
};

const budget = {
  id: '00000000-0000-0000-0000-000000000064',
  subjectType: 'project' as const,
  subjectId: '00000000-0000-0000-0000-000000000002',
  mode: 'enforce' as const,
  window: 'month' as const,
  limitUsd: '250.000000',
  createdAt: '2026-04-28T00:00:00Z',
  updatedAt: '2026-04-28T00:00:00Z',
};

const call = {
  id: '00000000-0000-0000-0000-000000000063',
  requestId: 'req_123',
  subjectType: 'run' as const,
  runId: '00000000-0000-0000-0000-000000000010',
  agentId: '00000000-0000-0000-0000-000000000011',
  projectId: '00000000-0000-0000-0000-000000000002',
  ownerUserId: '00000000-0000-0000-0000-000000000001',
  ccSessionId: 'sess_abc',
  ccAgentId: null,
  modelAlias: 'claude-sonnet-4-6',
  upstreamModel: 'claude-sonnet-4-6',
  protocol: 'anthropic' as const,
  mode: 'passthrough' as const,
  stream: true,
  status: 'success' as const,
  httpStatus: 200,
  errorCode: null,
  tokensIn: 120,
  tokensCacheWrite: 0,
  tokensCacheRead: 40,
  tokensOut: 300,
  tokensReasoning: 0,
  costUsd: '0.004860',
  ttfbMs: 210,
  latencyMs: 3400,
  startedAt: '2026-04-28T00:00:00Z',
  completedAt: '2026-04-28T00:00:03Z',
};

describe('enums', () => {
  it('llmProtocolSchema accepts the two protocol faces and rejects others', () => {
    expect(llmProtocolSchema.parse('anthropic')).toBe('anthropic');
    expect(llmProtocolSchema.parse('openai')).toBe('openai');
    expect(llmProtocolSchema.safeParse('bedrock').success).toBe(false);
  });

  it('llmRouteModeSchema carries exactly the three promise tiers (D2/D2b)', () => {
    expect(llmRouteModeSchema.options).toEqual(['passthrough', 'rewrite-model', 'translate']);
    expect(llmRouteModeSchema.safeParse('proxy').success).toBe(false);
  });

  it('llmAuthStyleSchema / llmBudgetModeSchema reject unknown values', () => {
    expect(llmAuthStyleSchema.parse('x-api-key')).toBe('x-api-key');
    expect(llmAuthStyleSchema.safeParse('basic').success).toBe(false);
    expect(llmBudgetModeSchema.options).toEqual(['observe', 'enforce']);
    expect(llmBudgetModeSchema.safeParse('block').success).toBe(false);
  });

  it('llmCallSubjectTypeSchema carries exactly run/service', () => {
    expect(llmCallSubjectTypeSchema.options).toEqual(['run', 'service']);
    expect(llmCallSubjectTypeSchema.parse('service')).toBe('service');
    expect(llmCallSubjectTypeSchema.safeParse('user').success).toBe(false);
  });

  it('llmBudgetSubjectTypeSchema / llmBudgetWindowSchema match the budget table', () => {
    expect(llmBudgetSubjectTypeSchema.options).toEqual(['global', 'project', 'user', 'agent']);
    expect(llmBudgetWindowSchema.options).toEqual(['day', 'month', 'total']);
    expect(llmBudgetSubjectTypeSchema.safeParse('team').success).toBe(false);
    expect(llmBudgetWindowSchema.safeParse('week').success).toBe(false);
  });

  it('llmCallStatusSchema covers every row of the error-code table', () => {
    expect(llmCallStatusSchema.options).toEqual([
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
    expect(llmCallStatusSchema.safeParse('ok').success).toBe(false);
  });
});

describe('createLlmCredentialRequestSchema', () => {
  it('accepts a bearer credential and defaults authStyle', () => {
    const parsed = createLlmCredentialRequestSchema.parse({
      name: 'anthropic-prod',
      value: 'sk-ant-abcdefgh',
    });
    expect(parsed.authStyle).toBe('bearer');
    expect(parsed.authHeader).toBeUndefined();
  });

  it('accepts authStyle="header" when authHeader is supplied', () => {
    expect(
      createLlmCredentialRequestSchema.parse({
        name: 'glm',
        value: 'secret-value',
        authStyle: 'header',
        authHeader: 'x-glm-key',
      }).authHeader
    ).toBe('x-glm-key');
  });

  it('rejects authStyle="header" without authHeader', () => {
    const r = createLlmCredentialRequestSchema.safeParse({
      name: 'glm',
      value: 'secret-value',
      authStyle: 'header',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['authHeader']);
    }
  });

  it('rejects a non-slug name and a too-short value', () => {
    expect(
      createLlmCredentialRequestSchema.safeParse({ name: 'Prod Key', value: 'sk-ant-abcdefgh' })
        .success
    ).toBe(false);
    expect(
      createLlmCredentialRequestSchema.safeParse({ name: 'prod', value: 'short' }).success
    ).toBe(false);
  });
});

describe('llmCredentialSchema — 密钥边界第一道闸门', () => {
  it('accepts a credential row projection', () => {
    expect(llmCredentialSchema.parse(credential).name).toBe('anthropic-prod');
  });

  it('has NO sealedValue / value key in its shape', () => {
    const keys = Object.keys(llmCredentialSchema.shape);
    expect(keys).not.toContain('sealedValue');
    expect(keys).not.toContain('value');
    expect(keys).toEqual([
      'id',
      'name',
      'alg',
      'keyId',
      'authStyle',
      'authHeader',
      'version',
      'createdAt',
      'updatedAt',
      'rotatedAt',
    ]);
  });

  it('strips sealedValue / value if an implementation ever leaks them in', () => {
    const parsed = llmCredentialSchema.parse({
      ...credential,
      sealedValue: 'BASE64CIPHERTEXT',
      value: 'sk-ant-REAL-KEY',
    });
    expect(parsed).not.toHaveProperty('sealedValue');
    expect(parsed).not.toHaveProperty('value');
    expect(JSON.stringify(parsed)).not.toContain('sk-ant-REAL-KEY');
  });

  it('rejects version 0 and a non-datetime createdAt', () => {
    expect(llmCredentialSchema.safeParse({ ...credential, version: 0 }).success).toBe(false);
    expect(llmCredentialSchema.safeParse({ ...credential, createdAt: 'yesterday' }).success).toBe(
      false
    );
  });

  it('response envelopes also drop the ciphertext', () => {
    const parsed = createLlmCredentialResponseSchema.parse({
      data: { ...credential, sealedValue: 'BASE64CIPHERTEXT' },
    });
    expect(parsed.data).not.toHaveProperty('sealedValue');

    const list = listLlmCredentialsResponseSchema.parse({
      data: [{ ...credential, sealedValue: 'BASE64CIPHERTEXT' }],
      nextCursor: null,
    });
    expect(list.data[0]).not.toHaveProperty('sealedValue');
  });
});

describe('rotateLlmCredentialRequestSchema', () => {
  it('accepts a new plaintext value', () => {
    expect(rotateLlmCredentialRequestSchema.parse({ value: 'sk-ant-newvalue' }).value).toBe(
      'sk-ant-newvalue'
    );
  });

  it('rejects a missing / too-short value', () => {
    expect(rotateLlmCredentialRequestSchema.safeParse({}).success).toBe(false);
    expect(rotateLlmCredentialRequestSchema.safeParse({ value: 'nope' }).success).toBe(false);
  });
});

describe('llmResourceParamsSchema', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(llmResourceParamsSchema.parse({ id: credential.id }).id).toBe(credential.id);
    expect(llmResourceParamsSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('provider contracts', () => {
  it('accepts a provider row', () => {
    expect(llmProviderSchema.parse(provider).protocol).toBe('anthropic');
  });

  it('rejects a non-URL baseUrl and a non-positive timeout', () => {
    expect(llmProviderSchema.safeParse({ ...provider, baseUrl: 'api.anthropic.com' }).success).toBe(
      false
    );
    expect(llmProviderSchema.safeParse({ ...provider, timeoutMs: 0 }).success).toBe(false);
  });

  it('create defaults headers / timeout / enabled', () => {
    const parsed = createLlmProviderRequestSchema.parse({
      name: 'glm',
      protocol: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    });
    expect(parsed).toMatchObject({ defaultHeaders: {}, timeoutMs: 600_000, enabled: true });
  });

  it('patch accepts a single field but rejects an empty body', () => {
    expect(patchLlmProviderRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(patchLlmProviderRequestSchema.safeParse({}).success).toBe(false);
  });

  it('list query parses "false" as false (not truthy string coercion)', () => {
    expect(listLlmProvidersQuerySchema.parse({ enabled: 'false' }).enabled).toBe(false);
    expect(listLlmProvidersQuerySchema.parse({ enabled: 'true' }).enabled).toBe(true);
    expect(listLlmProvidersQuerySchema.parse({}).limit).toBe(50);
    expect(listLlmProvidersQuerySchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });
});

describe('model contracts', () => {
  it('accepts a model row with decimal price strings', () => {
    expect(llmModelSchema.parse(model).priceCacheReadPerMtok).toBe('0.30');
  });

  it('rejects a non-decimal price string', () => {
    expect(llmModelSchema.safeParse({ ...model, priceInputPerMtok: '3 USD' }).success).toBe(false);
    expect(llmModelSchema.safeParse({ ...model, priceInputPerMtok: 3 }).success).toBe(false);
  });

  it('create defaults every price to "0"', () => {
    const parsed = createLlmModelRequestSchema.parse({
      alias: 'gpt-4o',
      providerId: provider.id,
      upstreamModel: 'gpt-4o',
    });
    expect(parsed.priceInputPerMtok).toBe('0');
    expect(parsed.priority).toBe(0);
    expect(parsed.enabled).toBe(true);
  });

  it('create rejects a missing providerId', () => {
    expect(
      createLlmModelRequestSchema.safeParse({ alias: 'gpt-4o', upstreamModel: 'gpt-4o' }).success
    ).toBe(false);
  });

  it('patch rejects an empty body', () => {
    expect(patchLlmModelRequestSchema.parse({ priority: 5 })).toEqual({ priority: 5 });
    expect(patchLlmModelRequestSchema.safeParse({}).success).toBe(false);
  });

  it('list query filters by providerId', () => {
    expect(listLlmModelsQuerySchema.parse({ providerId: provider.id }).providerId).toBe(
      provider.id
    );
    expect(listLlmModelsQuerySchema.safeParse({ providerId: 'nope' }).success).toBe(false);
  });
});

describe('budget contracts', () => {
  it('accepts a project-scoped budget row', () => {
    expect(llmBudgetSchema.parse(budget).subjectType).toBe('project');
  });

  it('accepts a global budget row with a null subjectId', () => {
    const parsed = llmBudgetSchema.parse({
      ...budget,
      subjectType: 'global',
      subjectId: null,
      window: 'total',
    });
    expect(parsed.subjectId).toBeNull();
  });

  it('rejects a global budget carrying a subjectId', () => {
    const r = llmBudgetSchema.safeParse({ ...budget, subjectType: 'global' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['subjectId']);
  });

  it('rejects a non-global budget without a subjectId', () => {
    expect(llmBudgetSchema.safeParse({ ...budget, subjectId: null }).success).toBe(false);
  });

  it('rejects an unknown window and a non-decimal limit on the row', () => {
    expect(llmBudgetSchema.safeParse({ ...budget, window: 'week' }).success).toBe(false);
    expect(llmBudgetSchema.safeParse({ ...budget, limitUsd: '250 USD' }).success).toBe(false);
  });

  it('put defaults to a global observe/day budget', () => {
    const parsed = putLlmBudgetRequestSchema.parse({ limitUsd: '10.00' });
    expect(parsed).toEqual({
      subjectType: 'global',
      subjectId: null,
      mode: 'observe',
      window: 'day',
      limitUsd: '10.00',
    });
  });

  it('put accepts every subject tier', () => {
    for (const subjectType of ['project', 'user', 'agent'] as const) {
      expect(
        putLlmBudgetRequestSchema.parse({
          subjectType,
          subjectId: budget.subjectId,
          limitUsd: '1',
        }).subjectType
      ).toBe(subjectType);
    }
  });

  it('put rejects an unknown window, a non-decimal limit and a subject mismatch', () => {
    expect(putLlmBudgetRequestSchema.safeParse({ limitUsd: '10', window: 'week' }).success).toBe(
      false
    );
    expect(putLlmBudgetRequestSchema.safeParse({ limitUsd: 'ten' }).success).toBe(false);
    expect(
      putLlmBudgetRequestSchema.safeParse({ subjectType: 'project', limitUsd: '10' }).success
    ).toBe(false);
  });
});

describe('call contracts', () => {
  it('accepts a completed call row', () => {
    expect(llmCallSchema.parse(call).status).toBe('success');
  });

  it('accepts an in-flight row with null completion fields', () => {
    const parsed = llmCallSchema.parse({
      ...call,
      status: 'client_abort',
      httpStatus: null,
      ttfbMs: null,
      latencyMs: null,
      completedAt: null,
    });
    expect(parsed.completedAt).toBeNull();
  });

  it('rejects negative token counts and an unknown status', () => {
    expect(llmCallSchema.safeParse({ ...call, tokensIn: -1 }).success).toBe(false);
    expect(llmCallSchema.safeParse({ ...call, status: 'weird' }).success).toBe(false);
  });

  it('list query accepts run/time filters and rejects a bad timestamp', () => {
    const parsed = listLlmCallsQuerySchema.parse({
      runId: call.runId,
      from: '2026-04-28T00:00:00Z',
      limit: '10',
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.runId).toBe(call.runId);
    expect(listLlmCallsQuerySchema.safeParse({ from: 'last-week' }).success).toBe(false);
    expect(listLlmCallsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Envelope wrappers — thin successResponseSchema / paginatedResponseSchema
// re-wraps. The factories themselves are covered in common.test.ts; this
// table just proves each exported wrapper is bound to the right payload.
// ---------------------------------------------------------------------------

describe('response envelopes', () => {
  it.each([
    ['createLlmProviderResponseSchema', createLlmProviderResponseSchema, provider],
    ['createLlmModelResponseSchema', createLlmModelResponseSchema, model],
    ['putLlmBudgetResponseSchema', putLlmBudgetResponseSchema, budget],
    ['rotateLlmCredentialResponseSchema', rotateLlmCredentialResponseSchema, credential],
  ])('%s accepts { data } and rejects a mismatched payload', (_name, schema, payload) => {
    expect(schema.parse({ data: payload }).data).toBeDefined();
    expect(schema.safeParse({ data: { id: 'nope' } }).success).toBe(false);
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ['listLlmProvidersResponseSchema', listLlmProvidersResponseSchema, provider],
    ['listLlmModelsResponseSchema', listLlmModelsResponseSchema, model],
    ['listLlmBudgetsResponseSchema', listLlmBudgetsResponseSchema, budget],
    ['listLlmCallsResponseSchema', listLlmCallsResponseSchema, call],
  ])('%s accepts a page and rejects a missing nextCursor', (_name, schema, payload) => {
    expect(schema.parse({ data: [payload], nextCursor: null }).data).toHaveLength(1);
    expect(schema.safeParse({ data: [payload] }).success).toBe(false);
    expect(schema.safeParse({ data: payload, nextCursor: null }).success).toBe(false);
  });

  it('deleteLlmCredentialResponseSchema pins deleted:true', () => {
    expect(
      deleteLlmCredentialResponseSchema.parse({ data: { id: credential.id, deleted: true } }).data
        .deleted
    ).toBe(true);
    expect(
      deleteLlmCredentialResponseSchema.safeParse({ data: { id: credential.id, deleted: false } })
        .success
    ).toBe(false);
  });

  it('listLlmCredentialsQuerySchema is the shared pagination query', () => {
    expect(listLlmCredentialsQuerySchema.parse({}).limit).toBe(50);
    expect(listLlmCredentialsQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    });
    expect(listLlmCredentialsQuerySchema.safeParse({ limit: '999' }).success).toBe(false);
  });
});
