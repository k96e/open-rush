/**
 * 批内聚合（M5·T5.1）。
 *
 * 这一层要守住三件事：
 *  ① 一条调用进 4 档作用域 × 3 个窗口，非空归属列才建档；
 *  ② **同一个 (作用域, 窗口) 只出一行**——否则 `ON CONFLICT DO UPDATE` 会报
 *    "cannot affect row a second time"，整批被丢；
 *  ③ 金额走定点累加，不掉浮点尾差。
 */
import { describe, expect, it } from 'vitest';
import { makeCallRecord } from '../../../test/call-records.js';
import { aggregateBudgetDeltas } from '../budget-delta.js';

const find = (
  deltas: ReturnType<typeof aggregateBudgetDeltas>,
  subjectType: string,
  windowKey: string
) => deltas.find((d) => d.subjectType === subjectType && d.windowKey === windowKey);

describe('aggregateBudgetDeltas', () => {
  it('空批回空数组', () => {
    expect(aggregateBudgetDeltas([])).toEqual([]);
  });

  it('只有 global 归属时出 3 行（day / month / total）', () => {
    const deltas = aggregateBudgetDeltas([makeCallRecord()]);
    expect(deltas).toHaveLength(3);
    expect(deltas.map((d) => d.windowKey).sort()).toEqual(['2026-09', '2026-09-08', 'total']);
    expect(deltas.every((d) => d.subjectType === 'global' && d.subjectId === null)).toBe(true);
  });

  it('四档归属齐全 → 4 作用域 × 3 窗口 = 12 行', () => {
    const deltas = aggregateBudgetDeltas([
      makeCallRecord({ projectId: 'p1', ownerUserId: 'u1', agentId: 'a1' }),
    ]);
    expect(deltas).toHaveLength(12);
    expect(find(deltas, 'project', '2026-09-08')).toMatchObject({ subjectId: 'p1', calls: 1 });
    expect(find(deltas, 'agent', 'total')).toMatchObject({ subjectId: 'a1', calls: 1 });
  });

  it('★ 同一批的同一个桶只出一行，且金额/条数累加', () => {
    const deltas = aggregateBudgetDeltas([
      makeCallRecord({ projectId: 'p1', costUsd: '0.000001' }),
      makeCallRecord({ projectId: 'p1', costUsd: '0.000002' }),
    ]);
    const keys = deltas.map((d) => `${d.subjectType}:${d.subjectId}|${d.windowKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(find(deltas, 'project', '2026-09-08')).toMatchObject({
      costUsd: '0.000003',
      calls: 2,
    });
  });

  it('★ 金额定点累加：0.1 加十次正好是 1.000000', () => {
    const batch = Array.from({ length: 10 }, () => makeCallRecord({ costUsd: '0.100000' }));
    expect(find(aggregateBudgetDeltas(batch), 'global', 'total')?.costUsd).toBe('1.000000');
  });

  it('tokens 是四类之和，**不含** reasoning（它是 output 的子集）', () => {
    const deltas = aggregateBudgetDeltas([
      makeCallRecord({
        tokensIn: 10,
        tokensCacheWrite: 20,
        tokensCacheRead: 30,
        tokensOut: 40,
        tokensReasoning: 40,
      }),
    ]);
    expect(find(deltas, 'global', 'total')?.tokens).toBe(100);
  });

  it('窗口键按 startedAt 切：跨零点的长调用记在它开始的那天', () => {
    const deltas = aggregateBudgetDeltas([
      makeCallRecord({
        startedAt: new Date('2026-09-08T23:59:00.000Z'),
        completedAt: new Date('2026-09-09T00:05:00.000Z'),
      }),
    ]);
    expect(deltas.map((d) => d.windowKey).sort()).toEqual(['2026-09', '2026-09-08', 'total']);
  });

  it('坏价格（负数 / 非数字）按 0 计，绝不抛', () => {
    const deltas = aggregateBudgetDeltas([makeCallRecord({ costUsd: 'not-a-number' })]);
    expect(find(deltas, 'global', 'total')?.costUsd).toBe('0.000000');
  });

  it('不同天的两条调用落进不同的 day 桶，但共享同一个 total 桶', () => {
    const deltas = aggregateBudgetDeltas([
      makeCallRecord({ startedAt: new Date('2026-09-08T10:00:00.000Z') }),
      makeCallRecord({ startedAt: new Date('2026-09-09T10:00:00.000Z') }),
    ]);
    expect(find(deltas, 'global', '2026-09-08')?.calls).toBe(1);
    expect(find(deltas, 'global', '2026-09-09')?.calls).toBe(1);
    expect(find(deltas, 'global', 'total')?.calls).toBe(2);
  });
});
