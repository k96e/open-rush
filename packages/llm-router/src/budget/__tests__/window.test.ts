/**
 * 预算窗口的键与边界（M5·T5.1 / T5.2）。
 *
 * 这两个函数是累计器与 429 `Retry-After` 的共同基础：键错了账就串桶，
 * 边界错了客户端要么空转重试要么白等一天。
 */
import { describe, expect, it } from 'vitest';
import {
  BUDGET_WINDOWS,
  secondsToWindowEnd,
  TOTAL_WINDOW_RETRY_AFTER_SEC,
  windowKeyFor,
} from '../window.js';

const at = (iso: string): Date => new Date(iso);

describe('windowKeyFor', () => {
  it('day → UTC 的 YYYY-MM-DD', () => {
    expect(windowKeyFor('day', at('2026-09-08T13:45:00.000Z'))).toBe('2026-09-08');
  });

  it('month → UTC 的 YYYY-MM', () => {
    expect(windowKeyFor('month', at('2026-09-08T13:45:00.000Z'))).toBe('2026-09');
  });

  it('total → 常量 total', () => {
    expect(windowKeyFor('total', at('2026-09-08T13:45:00.000Z'))).toBe('total');
  });

  it('★ 按 UTC 切而不是本地时区：UTC 次日 00:30 记在次日', () => {
    // 东八区看是 8:30，仍应落在 UTC 的 09-09。
    expect(windowKeyFor('day', at('2026-09-09T00:30:00.000Z'))).toBe('2026-09-09');
  });

  it('窗口键长度不超过 window_key 列的 20 字符', () => {
    for (const window of BUDGET_WINDOWS) {
      expect(windowKeyFor(window, at('2026-12-31T23:59:59.999Z')).length).toBeLessThanOrEqual(20);
    }
  });
});

describe('secondsToWindowEnd', () => {
  it('day：到 UTC 次日零点的秒数', () => {
    expect(secondsToWindowEnd('day', at('2026-09-08T23:59:00.000Z'))).toBe(60);
    expect(secondsToWindowEnd('day', at('2026-09-08T00:00:00.000Z'))).toBe(86_400);
  });

  it('month：到下月 1 日零点的秒数（跨年也对）', () => {
    expect(secondsToWindowEnd('month', at('2026-09-30T23:59:00.000Z'))).toBe(60);
    expect(secondsToWindowEnd('month', at('2026-12-31T23:00:00.000Z'))).toBe(3_600);
  });

  it('month：闰年的 2 月按 29 天算', () => {
    expect(secondsToWindowEnd('month', at('2028-02-28T00:00:00.000Z'))).toBe(2 * 86_400);
  });

  it('total 没有边界，用固定兜底值', () => {
    expect(secondsToWindowEnd('total', at('2026-09-08T00:00:00.000Z'))).toBe(
      TOTAL_WINDOW_RETRY_AFTER_SEC
    );
  });

  it('★ 边界那一毫秒也至少回 1 秒（回 0 会让客户端空转一轮）', () => {
    expect(secondsToWindowEnd('day', at('2026-09-08T23:59:59.999Z'))).toBe(1);
    expect(secondsToWindowEnd('month', at('2026-09-30T23:59:59.999Z'))).toBe(1);
  });
});
