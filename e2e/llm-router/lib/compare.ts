/**
 * 字节与结构比对（M7·T7.1，A1）。
 *
 * A1 分三档承诺，这里对应三个函数：
 *  - `bytesEqual`        → passthrough 档，逐字节；
 *  - `deepEqualExcept`   → rewrite-model 档，除 `$.model` 外解析后深度相等；
 *  - `sseEventTypes`     → translate 档，只比事件类型序列（不承诺字节一致）。
 */

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 第一处不同的字节下标；完全相同返回 -1。报告里贴这个比贴「不相等」有用得多。 */
export function firstDiffAt(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 键序无关的 JSON 序列化——`rewriteModelField` 会重建对象，键序不能拿来当证据。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 忽略若干顶层字段后是否深度相等。 */
export function deepEqualExcept(a: unknown, b: unknown, omit: readonly string[]): boolean {
  return stableStringify(omitKeys(a, omit)) === stableStringify(omitKeys(b, omit));
}

export function omitKeys(value: unknown, omit: readonly string[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!omit.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * 从 SSE 文本里抽事件类型序列。
 *
 * 优先读 `data:` 里的 `$.type`（Anthropic 面自带），没有就退回 `event:` 行——
 * OpenAI 面的 chunk 两者都没有，此时返回 `data` 占位，仍能比出「块数与顺序」。
 */
export function sseEventTypes(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data: '));
    const eventLine = block.split(/\r?\n/).find((l) => l.startsWith('event: '));
    if (dataLine) {
      const payload = dataLine.slice(6);
      if (payload === '[DONE]') {
        out.push('[DONE]');
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(payload);
        const type = (parsed as { type?: unknown } | null)?.type;
        out.push(typeof type === 'string' ? type : (eventLine?.slice(7) ?? 'data'));
        continue;
      } catch {
        // 落到 event: 行
      }
    }
    if (eventLine) out.push(eventLine.slice(7));
  }
  return out;
}

/** 把 SSE 里所有 `text_delta` / OpenAI `delta.content` 拼成最终文本（A11 ④ 的对拍）。 */
export function sseText(text: string): string {
  let out = '';
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data: '));
    if (!dataLine || dataLine.slice(6) === '[DONE]') continue;
    try {
      const evt = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
      const delta = evt.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') out += delta.text;
      const choices = evt.choices as Array<{ delta?: { content?: unknown } }> | undefined;
      const content = choices?.[0]?.delta?.content;
      if (typeof content === 'string') out += content;
    } catch {
      // 非 JSON 块跳过
    }
  }
  return out;
}
