/**
 * 计量单测的公共夹具：造 {@link CallRecord}。
 *
 * 与 `catalog-fixtures.ts` 同款——测试内部件放 `test/`，不进 `src/`，
 * 免得跟着 tsup 打进 dist。
 */
import type { CallRecord } from '../src/metering/call-record.js';

export function makeCallRecord(over: Partial<CallRecord> = {}): CallRecord {
  return {
    requestId: 'req-1',
    tokenId: null,
    subjectType: 'run',
    runId: null,
    agentId: null,
    projectId: null,
    ownerUserId: null,
    ccSessionId: null,
    ccAgentId: null,
    modelAlias: 'claude-sonnet-4-6',
    providerId: null,
    upstreamModel: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    mode: 'passthrough',
    stream: false,
    status: 'success',
    httpStatus: 200,
    errorCode: null,
    tokensIn: 100,
    tokensCacheWrite: 0,
    tokensCacheRead: 0,
    tokensOut: 50,
    tokensReasoning: 0,
    costUsd: '0.001050',
    ttfbMs: 120,
    latencyMs: 800,
    startedAt: new Date('2026-09-08T10:00:00.000Z'),
    completedAt: new Date('2026-09-08T10:00:01.000Z'),
    ...over,
  };
}
