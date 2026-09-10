import { describe, expect, it } from 'vitest';
import {
  CheckBuilder,
  escapeCell,
  renderConsole,
  renderSummaryTable,
  tally,
} from '../lib/report.js';

describe('CheckBuilder', () => {
  it('全部 expect 通过 → pass', () => {
    const r = new CheckBuilder('A1', 'title').expect(true, '一').expect(true, '二').done('ok');
    expect(r.verdict).toBe('pass');
    expect(r.evidence).toEqual(['OK   一', 'OK   二']);
  });

  it('任何一条 expect 失败 → fail，且失败原因留在 evidence 里', () => {
    const r = new CheckBuilder('A1', 'title').expect(true, '一').expect(false, '二').done('bad');
    expect(r.verdict).toBe('fail');
    expect(r.evidence[1]).toBe('FAIL 二');
  });

  it('partial 只把 pass 降级，不会把 fail 抬回来', () => {
    const downgraded = new CheckBuilder('A1', 't').expect(true, 'x').partial('测不到').done('d');
    expect(downgraded.verdict).toBe('partial');

    const stillFailing = new CheckBuilder('A1', 't').expect(false, 'x').partial('测不到').done('d');
    expect(stillFailing.verdict).toBe('fail');
  });

  it('note 不影响判定', () => {
    const r = new CheckBuilder('A1', 't').expect(true, 'x').note('仅供参考').done('d');
    expect(r.verdict).toBe('pass');
    expect(r.evidence[1]).toBe('--   仅供参考');
  });

  it('没有 metric 时 metrics 为 undefined（而不是空对象）', () => {
    expect(new CheckBuilder('A1', 't').done('d').metrics).toBeUndefined();
    expect(new CheckBuilder('A1', 't').metric('k', 1).done('d').metrics).toEqual({ k: 1 });
  });

  it('tradeoff 原样带到结果上', () => {
    expect(new CheckBuilder('A1', 't').tradeoff('软限额').done('d').tradeoff).toBe('软限额');
  });
});

describe('tally', () => {
  const mk = (verdict: 'pass' | 'partial' | 'fail') => ({
    id: 'A',
    title: 't',
    verdict,
    detail: 'd',
    evidence: [],
  });

  it('partial 不算失败 —— 它是被如实标注的取舍', () => {
    expect(tally([mk('pass'), mk('partial')])).toEqual({ pass: 1, partial: 1, fail: 0, ok: true });
  });

  it('有 fail 就不 ok', () => {
    expect(tally([mk('pass'), mk('fail')]).ok).toBe(false);
  });

  it('空结果算 ok（没有失败项）', () => {
    expect(tally([])).toEqual({ pass: 0, partial: 0, fail: 0, ok: true });
  });
});

describe('escapeCell / renderSummaryTable / renderConsole', () => {
  it('转义竖线并压掉换行，否则 Markdown 表会被撑破', () => {
    expect(escapeCell('a|b\nc')).toBe('a\\|b c');
    expect(escapeCell('a\r\nb')).toBe('a b');
  });

  it('取舍为空时渲染成破折号，而不是留白', () => {
    const table = renderSummaryTable([
      { id: 'A1', title: 't', verdict: 'pass', detail: 'ok', evidence: ['OK   e'] },
    ]);
    expect(table).toContain('| A1 | ✅ ok | OK   e | — |');
  });

  it('没有证据时证据列也是破折号', () => {
    const table = renderSummaryTable([
      { id: 'A2', title: 't', verdict: 'fail', detail: 'bad', evidence: [] },
    ]);
    expect(table).toContain('| A2 | ❌ bad | — | — |');
  });

  it('控制台渲染带出 metrics', () => {
    const out = renderConsole([
      {
        id: 'A7',
        title: 't',
        verdict: 'pass',
        detail: 'd',
        evidence: ['OK   e'],
        metrics: { notifyMs: 28 },
      },
    ]);
    expect(out).toContain('✅ A7 · t — d');
    expect(out).toContain('# notifyMs = 28');
  });
});
