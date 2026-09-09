/**
 * 预算闸门（M5·T5.2，A6）。要钉死的是两档语义、作用域优先级、缓存与降级：
 *  - 没配预算 → 放行；
 *  - `enforce=false` 且超限 → **放行**（累计不受影响，那是另一条旁路的事）；
 *  - `enforce=true` 且超限 → 拒绝 + `retryAfterSec`；
 *  - 作用域取最近的一档，命中之后不再往上找；
 *  - 缓存 TTL 内不重复查库；
 *  - 查库失败 → 放行 + 告警（可用性优先，`check` 永不抛）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Subject } from '../../auth/token-store.js';
import { BudgetService } from '../budget-service.js';
import type { BudgetRow, BudgetStore } from '../budget-store.js';
import type { BudgetScope } from '../scope.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');

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

function budget(over: Partial<BudgetRow> = {}): BudgetRow {
  return {
    subjectType: 'project',
    subjectId: 'proj-1',
    window: 'day',
    limitUsd: '10.000000',
    enforce: true,
    ...over,
  };
}

class FakeStore implements BudgetStore {
  budgetCalls = 0;
  usageCalls = 0;
  lastScope: BudgetScope | null = null;
  failBudgets = false;

  constructor(
    private readonly rows: BudgetRow[] = [],
    private readonly usage: Record<string, string> = {}
  ) {}

  async findBudgets(scopes: readonly BudgetScope[]): Promise<BudgetRow[]> {
    this.budgetCalls += 1;
    if (this.failBudgets) throw new Error('db is down');
    return this.rows.filter((r) =>
      scopes.some((s) => s.subjectType === r.subjectType && s.subjectId === r.subjectId)
    );
  }

  async findUsage(
    scope: BudgetScope,
    windowKeys: readonly string[]
  ): Promise<Record<string, string>> {
    this.usageCalls += 1;
    this.lastScope = scope;
    const out: Record<string, string> = {};
    for (const key of windowKeys) if (this.usage[key] !== undefined) out[key] = this.usage[key];
    return out;
  }
}

describe('BudgetService.check', () => {
  it('一档预算都没配 → 放行，且不去查累计值', async () => {
    const store = new FakeStore();
    const service = new BudgetService(store);
    await expect(service.check(subject(), NOW)).resolves.toEqual({ allowed: true });
    expect(store.usageCalls).toBe(0);
  });

  it('配了预算但没超 → 放行', async () => {
    const service = new BudgetService(new FakeStore([budget()], { '2026-09-08': '3.500000' }));
    await expect(service.check(subject(), NOW)).resolves.toEqual({ allowed: true });
  });

  it('★ enforce=false 且已超限 → 放行（A6：不卡业务但仍计量）', async () => {
    const service = new BudgetService(
      new FakeStore([budget({ enforce: false })], { '2026-09-08': '99.000000' })
    );
    await expect(service.check(subject(), NOW)).resolves.toEqual({ allowed: true });
  });

  it('★ enforce=true 且已超限 → 拒绝，带 used/limit/window 与 retryAfterSec', async () => {
    const service = new BudgetService(new FakeStore([budget()], { '2026-09-08': '12.500000' }));
    const decision = await service.check(subject(), NOW);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe(
      'budget exceeded for project proj-1: 12.50/10.000000 USD (window=day)'
    );
    // 12:00 UTC → 到次日零点还有 12 小时
    expect(decision.retryAfterSec).toBe(43_200);
    expect(decision.window).toBe('day');
    expect(decision.scope).toEqual({ subjectType: 'project', subjectId: 'proj-1' });
  });

  it('用满（used == limit）即算超限', async () => {
    const service = new BudgetService(new FakeStore([budget()], { '2026-09-08': '10.000000' }));
    expect((await service.check(subject(), NOW)).allowed).toBe(false);
  });

  it('累计器还没有这个窗口的行 → 按 0 算，放行', async () => {
    const service = new BudgetService(new FakeStore([budget()], {}));
    await expect(service.check(subject(), NOW)).resolves.toEqual({ allowed: true });
  });

  it('★ 作用域取最近的一档：agent 配了就不再看 project / global', async () => {
    const store = new FakeStore(
      [
        budget({ subjectType: 'agent', subjectId: 'agent-1', limitUsd: '100.000000' }),
        budget({ subjectType: 'project', subjectId: 'proj-1', limitUsd: '1.000000' }),
        budget({ subjectType: 'global', subjectId: null, limitUsd: '0.000001' }),
      ],
      { '2026-09-08': '5.000000' }
    );
    await expect(new BudgetService(store).check(subject(), NOW)).resolves.toEqual({
      allowed: true,
    });
    expect(store.lastScope).toEqual({ subjectType: 'agent', subjectId: 'agent-1' });
  });

  it('★ 近的那档没配就往上找：没有 agent 预算时用 project', async () => {
    const store = new FakeStore(
      [budget({ subjectType: 'project', subjectId: 'proj-1', limitUsd: '1.000000' })],
      { '2026-09-08': '5.000000' }
    );
    const decision = await new BudgetService(store).check(subject(), NOW);
    expect(decision.allowed).toBe(false);
    expect(store.lastScope).toEqual({ subjectType: 'project', subjectId: 'proj-1' });
  });

  it('归属列为空的档跳过，最终落到 global', async () => {
    const store = new FakeStore(
      [budget({ subjectType: 'global', subjectId: null, window: 'total', limitUsd: '1.000000' })],
      { total: '9.000000' }
    );
    const decision = await new BudgetService(store).check(
      subject({ agentId: null, projectId: null, ownerUserId: null }),
      NOW
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.scope).toEqual({ subjectType: 'global', subjectId: null });
  });

  it('同一作用域配了多个窗口时按 day → month → total 取第一条超限的', async () => {
    const store = new FakeStore(
      [
        budget({ window: 'day', limitUsd: '100.000000' }),
        budget({ window: 'month', limitUsd: '10.000000' }),
        budget({ window: 'total', limitUsd: '1.000000' }),
      ],
      { '2026-09-08': '1.000000', '2026-09': '50.000000', total: '500.000000' }
    );
    const decision = await new BudgetService(store).check(subject(), NOW);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.window).toBe('month');
    // 9 月还剩 22 天 12 小时
    expect(decision.retryAfterSec).toBe(22 * 86_400 + 43_200);
  });

  it('observe 的窗口超了不拦，但同作用域另一个 enforce 的窗口仍然拦', async () => {
    const store = new FakeStore(
      [
        budget({ window: 'day', limitUsd: '1.000000', enforce: false }),
        budget({ window: 'total', limitUsd: '1.000000', enforce: true }),
      ],
      { '2026-09-08': '9.000000', total: '9.000000' }
    );
    const decision = await new BudgetService(store).check(subject(), NOW);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.window).toBe('total');
    expect(decision.retryAfterSec).toBe(3_600);
  });

  it('★ 缓存 TTL 内不重复查库；invalidate 之后再查', async () => {
    const store = new FakeStore([budget()], { '2026-09-08': '1.000000' });
    const service = new BudgetService(store, { cacheTtlMs: 10_000 });

    await service.check(subject(), NOW);
    await service.check(subject(), NOW);
    await service.check(subject(), NOW);
    expect(store.budgetCalls).toBe(1);
    expect(store.usageCalls).toBe(1);

    service.invalidate();
    await service.check(subject(), NOW);
    expect(store.budgetCalls).toBe(2);
  });

  it('TTL 到期后重新查库（软限额的上界就是这个 TTL）', async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore([budget()], { '2026-09-08': '1.000000' });
      const service = new BudgetService(store, { cacheTtlMs: 10_000 });
      await service.check(subject(), NOW);
      vi.advanceTimersByTime(10_001);
      await service.check(subject(), NOW);
      expect(store.budgetCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cacheTtlMs=0 → 每次查库（硬限额）', async () => {
    const store = new FakeStore([budget()], { '2026-09-08': '1.000000' });
    const service = new BudgetService(store, { cacheTtlMs: 0 });
    await service.check(subject(), NOW);
    await service.check(subject(), NOW);
    expect(store.budgetCalls).toBe(2);
  });

  it('不同 subject 各自缓存，不会互相串档', async () => {
    const store = new FakeStore([budget({ subjectId: 'proj-1', limitUsd: '1.000000' })], {
      '2026-09-08': '5.000000',
    });
    const service = new BudgetService(store);
    expect((await service.check(subject(), NOW)).allowed).toBe(false);
    expect((await service.check(subject({ projectId: 'proj-2' }), NOW)).allowed).toBe(true);
  });

  it('★ 查库失败 → 放行 + 告警，check 不抛', async () => {
    const store = new FakeStore([budget()], { '2026-09-08': '99.000000' });
    store.failBudgets = true;
    const onError = vi.fn();
    const service = new BudgetService(store, { onError });

    await expect(service.check(subject(), NOW)).resolves.toEqual({ allowed: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
