import { describe, expect, it } from 'vitest';
import { computeCostUsd, formatMicrosUsd, type ModelPricing, parsePriceToMicros } from '../cost.js';
import type { WireUsage } from '../types.js';

const PRICING: ModelPricing = {
  priceInputPerMtok: '3.000000',
  priceOutputPerMtok: '15.000000',
  priceCacheWritePerMtok: '3.750000',
  priceCacheReadPerMtok: '0.300000',
  priceReasoningPerMtok: '1.000000',
};

const ZERO_PRICING: ModelPricing = {
  priceInputPerMtok: '0',
  priceOutputPerMtok: '0',
  priceCacheWritePerMtok: '0',
  priceCacheReadPerMtok: '0',
  priceReasoningPerMtok: '0',
};

const usage = (u: Partial<WireUsage>): WireUsage => ({
  tokensIn: 0,
  tokensCacheWrite: 0,
  tokensCacheRead: 0,
  tokensOut: 0,
  tokensReasoning: 0,
  ...u,
});

describe('parsePriceToMicros', () => {
  it.each([
    ['3', 3_000_000n],
    ['3.5', 3_500_000n],
    ['0.000003', 3n],
    ['1.234567', 1_234_567n],
    ['0', 0n],
    ['12.0000004', 12_000_000n], // 第 7 位小数 <5 → 舍
    ['12.0000006', 12_000_001n], // 第 7 位小数 ≥5 → 入
  ])('%s → %s', (input, expected) => {
    expect(parsePriceToMicros(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    '',
    '  ',
    'abc',
    '-1',
    'NaN',
    '1e6',
  ])('非法价格 %s 按 0 处理而不抛', (input) => {
    expect(parsePriceToMicros(input as string | null | undefined)).toBe(0n);
  });
});

describe('formatMicrosUsd', () => {
  it.each([
    [0n, '0.000000'],
    [1n, '0.000001'],
    [1_234_567n, '1.234567'],
    [1_000_000n, '1.000000'],
  ])('%s → %s', (input, expected) => {
    expect(formatMicrosUsd(input)).toBe(expected);
  });
});

describe('computeCostUsd', () => {
  it('五类 token 各自计价后相加', () => {
    // 1e6*3 + 1e6*15 + 1e6*3.75 + 1e6*0.3 + 1e6*1
    const cost = computeCostUsd(
      usage({
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        tokensCacheWrite: 1_000_000,
        tokensCacheRead: 1_000_000,
        tokensReasoning: 1_000_000,
      }),
      PRICING
    );
    expect(cost).toBe('23.050000');
  });

  it('每一类单独计价互不串扰', () => {
    expect(computeCostUsd(usage({ tokensIn: 1_000_000 }), PRICING)).toBe('3.000000');
    expect(computeCostUsd(usage({ tokensOut: 1_000_000 }), PRICING)).toBe('15.000000');
    expect(computeCostUsd(usage({ tokensCacheWrite: 1_000_000 }), PRICING)).toBe('3.750000');
    expect(computeCostUsd(usage({ tokensCacheRead: 1_000_000 }), PRICING)).toBe('0.300000');
    expect(computeCostUsd(usage({ tokensReasoning: 1_000_000 }), PRICING)).toBe('1.000000');
  });

  it('零价目录 → 0.000000', () => {
    expect(computeCostUsd(usage({ tokensIn: 999_999, tokensOut: 12_345 }), ZERO_PRICING)).toBe(
      '0.000000'
    );
  });

  it('零用量 → 0.000000', () => {
    expect(computeCostUsd(usage({}), PRICING)).toBe('0.000000');
  });

  it('缺字段 / 非法字段的价格按 0 计，不影响其他项', () => {
    const partial = {
      priceInputPerMtok: '3',
      priceOutputPerMtok: 'not-a-number',
      priceCacheWritePerMtok: '',
      priceCacheReadPerMtok: '0',
      priceReasoningPerMtok: '0',
    } as ModelPricing;
    expect(computeCostUsd(usage({ tokensIn: 1_000_000, tokensOut: 1_000_000 }), partial)).toBe(
      '3.000000'
    );
  });

  it('定点运算：小额调用不出现浮点尾巴', () => {
    // 3 tokens × 0.000003 USD/Mtok = 9e-12 → 舍到 0.000000
    expect(
      computeCostUsd(usage({ tokensIn: 3 }), { ...ZERO_PRICING, priceInputPerMtok: '0.000003' })
    ).toBe('0.000000');
    // 1234 tokens × 3 USD/Mtok = 0.003702，float 下常见 0.0037019999999999997
    expect(computeCostUsd(usage({ tokensIn: 1234 }), PRICING)).toBe('0.003702');
  });

  it('四舍五入到微美元', () => {
    // 1 token × 1.5 USD/Mtok = 1.5e-6 → 0.000002（半进一）
    expect(
      computeCostUsd(usage({ tokensIn: 1 }), { ...ZERO_PRICING, priceInputPerMtok: '1.5' })
    ).toBe('0.000002');
    // 1 token × 1.4 USD/Mtok = 1.4e-6 → 0.000001
    expect(
      computeCostUsd(usage({ tokensIn: 1 }), { ...ZERO_PRICING, priceInputPerMtok: '1.4' })
    ).toBe('0.000001');
  });

  it('负数 / NaN 的 token 计数按 0 处理', () => {
    expect(computeCostUsd(usage({ tokensIn: -5, tokensOut: Number.NaN }), PRICING)).toBe(
      '0.000000'
    );
  });
});
