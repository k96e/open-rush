/**
 * 逐调用计价（M4·T4.4，C2 §7.5）。
 *
 * **全程定点整数运算**，不碰浮点。价格列是 PostgreSQL `numeric(12,6)`，drizzle
 * 映射成字符串；`0.000003 * 3` 这类在 float 下会掉进 `9.000000000000001e-6`，
 * 累到几十万次调用就是肉眼可见的对账差。这里把价格解析成「每 Mtok 多少微美元」
 * 的 BigInt，五项先累加再一次性四舍五入，最后格式化成 `numeric(12,6)` 可直接
 * 写入的字符串。
 *
 * 五类 token 各自计价（A5 要求推理 token 单列）。注意 OpenAI 面的
 * `reasoning_tokens` 是 `completion_tokens` 的**子集**：`priceReasoningPerMtok`
 * 默认 0，此时不会重复计费；运营方把它设成非 0，语义就是「推理 token 在输出价
 * 之外**额外**加收这么多」——这是一条定价策略，不是解析 bug。
 */
import type { CatalogModel } from '../catalog/types.js';
import type { WireUsage } from './types.js';

/** 价格的定点标度：每 Mtok 的微美元数。 */
const PRICE_SCALE = 6;
const MICRO = 1_000_000n;

/**
 * `"1.234567"` → `1234567n`（微美元/Mtok）。
 *
 * 非法 / 负数 / 空串一律按 0 处理——目录里出现坏价格时，宁可这次调用记 0 元也
 * 不要让转发路径抛错（A5：计量失败不阻塞上层调用）。超过 6 位小数的部分四舍五入。
 */
export function parsePriceToMicros(raw: string | null | undefined): bigint {
  if (typeof raw !== 'string') return 0n;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 0n;
  const dot = text.indexOf('.');
  const intPart = dot < 0 ? text : text.slice(0, dot);
  const fracRaw = dot < 0 ? '' : text.slice(dot + 1);
  const frac = fracRaw.slice(0, PRICE_SCALE).padEnd(PRICE_SCALE, '0');
  const base = BigInt(intPart) * MICRO + BigInt(frac === '' ? '0' : frac);
  // 第 7 位小数进位。
  const next = fracRaw.charCodeAt(PRICE_SCALE);
  return next >= 53 /* '5' */ && next <= 57 /* '9' */ ? base + 1n : base;
}

/** 非负整数 token 数；非法值按 0（同上，绝不抛）。 */
function tokenCount(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value));
}

/** `1234567n` 微美元 → `"1.234567"`，可直接写入 `numeric(12,6)`。 */
export function formatMicrosUsd(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(PRICE_SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * 计算一次调用的花费。返回 `numeric(12,6)` 兼容的字符串。
 *
 * 只需要模型的五个价格列，所以入参用结构化子集而不是整个 {@link CatalogModel}——
 * 单测可以直接传字面量。
 */
export type ModelPricing = Pick<
  CatalogModel,
  | 'priceInputPerMtok'
  | 'priceOutputPerMtok'
  | 'priceCacheWritePerMtok'
  | 'priceCacheReadPerMtok'
  | 'priceReasoningPerMtok'
>;

export function computeCostUsd(usage: WireUsage, model: ModelPricing): string {
  // 单位：token × (微美元/Mtok)。除以 1e6 才是微美元，故先累加再统一收敛。
  const scaled =
    tokenCount(usage.tokensIn) * parsePriceToMicros(model.priceInputPerMtok) +
    tokenCount(usage.tokensOut) * parsePriceToMicros(model.priceOutputPerMtok) +
    tokenCount(usage.tokensCacheWrite) * parsePriceToMicros(model.priceCacheWritePerMtok) +
    tokenCount(usage.tokensCacheRead) * parsePriceToMicros(model.priceCacheReadPerMtok) +
    tokenCount(usage.tokensReasoning) * parsePriceToMicros(model.priceReasoningPerMtok);

  // 四舍五入到微美元。
  return formatMicrosUsd((scaled + MICRO / 2n) / MICRO);
}
