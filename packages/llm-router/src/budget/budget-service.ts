/**
 * 预算闸门（M5·T5.2，C5 §7.13，A6）。
 *
 * 两档语义：
 *   `enforce = false`（observe）→ 只累计不拦截——A6 的「开关关闭时不卡业务但仍计量」。
 *                                 累计发生在 {@link BatchingCallRecorder} 那条旁路上，
 *                                 与本闸门完全独立，所以关掉拦截不会关掉账。
 *   `enforce = true`            → 超限 429 + `Retry-After`（到窗口边界的秒数）。
 *
 * 作用域**取最近的一档**（`agent → project → user → global`）：命中最靠近调用者的
 * 那一档之后就不再往上找。给某个项目单独抬额度时不必再动全局那一行——这也是
 * `specs/llm-router.md` 与 R4 §5.7 写死的语义。同一作用域可以三个窗口各配一行，
 * 那三行会**一起判**，按 day → month → total 的顺序取第一条超限的。
 *
 * 一致性取舍（**必须写进验收报告**）：读的是缓存的累计值（TTL 默认 10s），所以是
 * **软限额**——高并发下可能超出限额一个 TTL 内的少量金额。把每次调用都做成强一致
 * 事务会给转发路径加一次同步写，与「极薄」正相反。需要硬限额时把 `cacheTtlMs` 设为 0。
 *
 * 可用性：DB 抖动时**放行**并告警（`check` 永不抛）。计费的可靠性由累计器保证，
 * 闸门的作用是止损；让一次 DB 抖动把所有 LLM 调用打死是更坏的结果。
 */
import type { Subject } from '../auth/token-store.js';
import { parsePriceToMicros } from '../usage/cost.js';
import type { BudgetRow, BudgetStore } from './budget-store.js';
import { type BudgetScope, resolveScopes, scopeKey } from './scope.js';
import { BUDGET_WINDOWS, type BudgetWindow, secondsToWindowEnd, windowKeyFor } from './window.js';

export type BudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      retryAfterSec: number;
      scope: BudgetScope;
      window: BudgetWindow;
    };

const ALLOWED: BudgetDecision = { allowed: true };

export interface BudgetServiceOptions {
  /** 累计值与预算配置的缓存 TTL。0 = 每次查库（硬限额）。 */
  cacheTtlMs?: number;
  /** 查库失败时的告警回调。失败一律放行。 */
  onError?: (err: unknown) => void;
}

interface CacheEntry {
  /** 命中的最近一档作用域；null = 四档都没配预算。 */
  scope: BudgetScope | null;
  rows: BudgetRow[];
  /** windowKey → 已用金额（微美元）。 */
  used: Map<string, bigint>;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 10_000;

/** 判定顺序固定，好让「超了哪一档」在报表里可复现。 */
const WINDOW_ORDER: readonly BudgetWindow[] = BUDGET_WINDOWS;

export class BudgetService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(
    private readonly store: BudgetStore,
    private readonly opts: BudgetServiceOptions = {}
  ) {
    this.cacheTtlMs = Math.max(0, opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  }

  async check(subject: Subject, now: Date = new Date()): Promise<BudgetDecision> {
    let entry: CacheEntry;
    try {
      entry = await this.load(subject, now);
    } catch (err) {
      // 可用性优先：查不到预算就放行，但要告警。
      this.opts.onError?.(err);
      return ALLOWED;
    }

    if (!entry.scope || entry.rows.length === 0) return ALLOWED;

    for (const window of WINDOW_ORDER) {
      const row = entry.rows.find((r) => r.window === window);
      if (!row) continue;
      const windowKey = windowKeyFor(window, now);
      const used = entry.used.get(windowKey) ?? 0n;
      const limit = parsePriceToMicros(row.limitUsd);
      if (used < limit) continue;
      // observe 档：超了也放行，账照记。
      if (!row.enforce) continue;
      return {
        allowed: false,
        reason:
          `budget exceeded for ${entry.scope.subjectType} ${entry.scope.subjectId ?? '*'}: ` +
          `${formatUsd(used)}/${row.limitUsd} USD (window=${window})`,
        retryAfterSec: secondsToWindowEnd(window, now),
        scope: entry.scope,
        window,
      };
    }
    return ALLOWED;
  }

  /** 缓存的失效入口（预算被改动时可以由控制面调用；目前只有单测用）。 */
  invalidate(): void {
    this.cache.clear();
  }

  private async load(subject: Subject, now: Date): Promise<CacheEntry> {
    const scopes = resolveScopes(subject);
    const key = scopes.map(scopeKey).join('>');
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit;

    const budgets = await this.store.findBudgets(scopes);
    // 「取最近的一档」：按候选顺序找第一个有配置的作用域。
    const scope = scopes.find((s) => budgets.some((b) => sameScope(b, s))) ?? null;
    const rows = scope ? budgets.filter((b) => sameScope(b, scope)) : [];

    const used = new Map<string, bigint>();
    if (scope && rows.length > 0) {
      const windowKeys = rows.map((r) => windowKeyFor(r.window, now));
      const raw = await this.store.findUsage(scope, windowKeys);
      for (const [windowKey, cost] of Object.entries(raw)) {
        used.set(windowKey, parsePriceToMicros(cost));
      }
    }

    // 缓存的是「按加载时刻的窗口键取到的累计值」。跨零点的那一个 TTL 内，
    // 新窗口键在缓存里查不到 → 按 0 算 → 放行。这与软限额是同一个取舍方向
    // （宁可少拦一点也不加同步写），且每天最多只发生一次、最长一个 TTL。
    const entry: CacheEntry = { scope, rows, used, expiresAt: Date.now() + this.cacheTtlMs };
    // TTL 为 0 时不进缓存——留着只会让 Map 无限长大。
    if (this.cacheTtlMs > 0) this.cache.set(key, entry);
    return entry;
  }
}

function sameScope(row: BudgetRow, scope: BudgetScope): boolean {
  return row.subjectType === scope.subjectType && row.subjectId === scope.subjectId;
}

/** 微美元 → 两位小数的展示串。只进错误文案，不进库。 */
function formatUsd(micros: bigint): string {
  return (Number(micros) / 1_000_000).toFixed(2);
}
