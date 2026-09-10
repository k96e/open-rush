/**
 * 验收结果的记账与渲染（M7·T7.1）。
 *
 * 刻意只有三种判定：`pass` / `partial` / `fail`。**`partial` 是一等公民**——
 * M7 的评分口径是「论证完整性」而不是「全绿」，把「机制已落、但本机环境测不了
 * 那一半」如实标成 partial，比标 pass 再在脚注里含糊解释要诚实得多。
 */

export type Verdict = 'pass' | 'partial' | 'fail';

export interface CheckResult {
  /** A1–A11。 */
  id: string;
  title: string;
  verdict: Verdict;
  /** 一句话结论，进汇总表。 */
  detail: string;
  /** 逐条断言的明细，进详表。 */
  evidence: string[];
  /** 已知取舍。R6 要求这一栏不能空着——空着时渲染成 `—`。 */
  tradeoff?: string;
  /** 实测数值（延迟、生效时间等），进 JSON 结果文件供文档引用。 */
  metrics?: Record<string, number | string>;
}

const MARK: Record<Verdict, string> = { pass: '✅', partial: '🟡', fail: '❌' };

/** 表格单元格里的 `|` 与换行会把 Markdown 表撑破。 */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderSummaryTable(results: readonly CheckResult[]): string {
  const lines = ['| 指标 | 结论 | 证据 | 取舍/备注 |', '|---|---|---|---|'];
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${MARK[r.verdict]} ${escapeCell(r.detail)} | ${escapeCell(
        r.evidence[0] ?? '—'
      )} | ${escapeCell(r.tradeoff ?? '—')} |`
    );
  }
  return lines.join('\n');
}

export function renderConsole(results: readonly CheckResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    out.push(`${MARK[r.verdict]} ${r.id} · ${r.title} — ${r.detail}`);
    for (const e of r.evidence) out.push(`     · ${e}`);
    if (r.metrics) {
      for (const [k, v] of Object.entries(r.metrics)) out.push(`     # ${k} = ${v}`);
    }
  }
  return out.join('\n');
}

export interface Tally {
  pass: number;
  partial: number;
  fail: number;
  /** 有 `fail` 就是不通过。`partial` 不算失败——它是被如实标注的取舍。 */
  ok: boolean;
}

export function tally(results: readonly CheckResult[]): Tally {
  const counts = { pass: 0, partial: 0, fail: 0 };
  for (const r of results) counts[r.verdict] += 1;
  return { ...counts, ok: counts.fail === 0 };
}

/**
 * 收集器。断言写成 `expect(cond, '说明')`，任何一条不成立就把这项拉成 fail，
 * 并把失败原因原样留在 evidence 里——不抛异常，因为一项挂掉不该让后面十项不跑。
 */
export class CheckBuilder {
  private readonly evidence: string[] = [];
  private verdict: Verdict = 'pass';
  private tradeoffText: string | undefined;
  private readonly metrics: Record<string, number | string> = {};

  constructor(
    private readonly id: string,
    private readonly title: string
  ) {}

  expect(condition: boolean, description: string): this {
    this.evidence.push(`${condition ? 'OK  ' : 'FAIL'} ${description}`);
    if (!condition) this.verdict = 'fail';
    return this;
  }

  note(description: string): this {
    this.evidence.push(`--   ${description}`);
    return this;
  }

  /** 机制已落但本机环境证不到那一半时用；不会把已有的 fail 降级回 partial。 */
  partial(description: string): this {
    this.evidence.push(`~~   ${description}`);
    if (this.verdict === 'pass') this.verdict = 'partial';
    return this;
  }

  metric(key: string, value: number | string): this {
    this.metrics[key] = value;
    return this;
  }

  tradeoff(text: string): this {
    this.tradeoffText = text;
    return this;
  }

  done(detail: string): CheckResult {
    return {
      id: this.id,
      title: this.title,
      verdict: this.verdict,
      detail,
      evidence: this.evidence,
      tradeoff: this.tradeoffText,
      metrics: Object.keys(this.metrics).length > 0 ? this.metrics : undefined,
    };
  }
}
