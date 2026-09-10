import { describe, expect, it } from 'vitest';
import {
  type BenchReport,
  formatTable,
  parseArgs,
  percentile,
  summarize,
} from '../bench-llm-router.ts';

describe('parseArgs', () => {
  it('缺省值可用（除了 token —— 那个没有合理默认）', () => {
    const args = parseArgs([]);
    expect(args.gateway).toBe('http://127.0.0.1:8790');
    expect(args.concurrency).toEqual([1, 8, 32]);
    expect(args.stream).toBe(true);
    expect(args.json).toBe(false);
    expect(args.token).toBe('');
  });

  it('解析各个开关', () => {
    const args = parseArgs([
      '--gateway',
      'http://gw:1/',
      '--upstream',
      'http://up:2/',
      '--token',
      'rt_x',
      '--model',
      'm',
      '--n',
      '50',
      '--concurrency',
      '2, 4 ,2',
      '--stream',
      'false',
      '--json',
    ]);
    expect(args.gateway).toBe('http://gw:1'); // 尾斜杠被去掉，拼 path 时不会出现 //
    expect(args.upstream).toBe('http://up:2');
    expect(args.token).toBe('rt_x');
    expect(args.n).toBe(50);
    expect(args.concurrency).toEqual([2, 4]); // 去重
    expect(args.stream).toBe(false);
    expect(args.json).toBe(true);
  });

  it('非法数值回落到缺省 / 下限，不会跑出 0 次或负并发', () => {
    const args = parseArgs(['--n', 'abc', '--concurrency', '0,-3']);
    expect(args.n).toBe(200);
    expect(args.concurrency).toEqual([1]);
  });

  it('值缺失或看起来像下一个开关时跳过，不吞掉后面的参数', () => {
    const args = parseArgs(['--token', '--json']);
    expect(args.token).toBe('');
    expect(args.json).toBe(true);
  });

  it('忽略不带 -- 前缀的游离参数', () => {
    expect(parseArgs(['garbage', '--n', '3']).n).toBe(3);
  });
});

describe('percentile', () => {
  it('单点样本各分位都等于它自己', () => {
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([5], 99)).toBe(5);
  });

  it('p0 / p100 落在两端', () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });

  it('按最近秩线性插值', () => {
    expect(percentile([0, 10], 50)).toBe(5);
    expect(percentile([0, 100], 95)).toBeCloseTo(95, 6);
  });

  it('乱序输入先排序', () => {
    expect(percentile([9, 1, 5], 50)).toBe(5);
  });

  it('空样本返回 NaN —— **不是** 0，否则「没测到」和「快得测不出来」长得一样', () => {
    expect(Number.isNaN(percentile([], 95))).toBe(true);
  });
});

describe('summarize', () => {
  it('给出 count / p50 / p95 / p99 / max', () => {
    const s = summarize([1, 2, 3, 4, 5]);
    expect(s.count).toBe(5);
    expect(s.p50).toBe(3);
    expect(s.max).toBe(5);
  });

  it('空样本全 NaN，count 为 0', () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.p95)).toBe(true);
    expect(Number.isNaN(s.max)).toBe(true);
  });
});

describe('formatTable', () => {
  const report: BenchReport = {
    args: {
      gateway: 'g',
      upstream: 'u',
      model: 'm',
      n: 10,
      concurrency: [1],
      stream: true,
    },
    results: [
      {
        concurrency: 1,
        direct: { ttfb: summarize([1, 1, 1]), total: summarize([2, 2, 2]), errors: 0 },
        gateway: { ttfb: summarize([3, 3, 3]), total: summarize([4, 4, 4]), errors: 1 },
        deltaTtfbP95: 2,
        deltaTotalP95: 2,
      },
    ],
  };

  it('TTFB 与总耗时分列，错误数是两条腿的和', () => {
    const table = formatTable(report);
    expect(table).toContain('| 1 | 1 ms | 3 ms | **2 ms** | 2 ms | 4 ms | **2 ms** | 1 |');
  });

  it('表头明确区分 TTFB 与总耗时（R6 要求分开报）', () => {
    expect(formatTable(report)).toContain('ΔTTFB p95');
    expect(formatTable(report)).toContain('Δ总耗时 p95');
  });

  it('NaN 原样透出，不会被伪装成 0', () => {
    const empty: BenchReport = {
      ...report,
      results: [
        {
          concurrency: 1,
          direct: { ttfb: summarize([]), total: summarize([]), errors: 3 },
          gateway: { ttfb: summarize([]), total: summarize([]), errors: 3 },
          deltaTtfbP95: Number.NaN,
          deltaTotalP95: Number.NaN,
        },
      ],
    };
    expect(formatTable(empty)).toContain('NaN ms');
  });
});
