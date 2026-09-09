/**
 * SSE 行缓冲（M4·T4.4）。两个协议的解析器共用同一份取行逻辑。
 *
 * 两个必须保证的细节：
 *  1. `TextDecoder.decode(chunk, { stream: true })` —— 上游分块可以切在任意字节
 *     边界上，不带 `stream:true` 的话跨 chunk 的多字节 UTF-8 会被解成 U+FFFD；
 *  2. 只认 `data:` 行，`event:` / `id:` / `retry:` / 注释行（`:`）/ 空行全部跳过。
 *     `[DONE]` 也在这里滤掉。
 *
 * 半包（最后一行没有换行符）留在缓冲里等下一个 chunk；流结束时那半行本来就不是
 * 完整事件，丢掉不影响用量（用量总在 `message_delta` / 末个 usage chunk 上）。
 */

const DECODER_FATAL = false;

export class SseLineReader {
  private buf = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: DECODER_FATAL });

  /** 把一个 chunk 拆成若干条 `data:` 载荷（已去掉前缀与首尾空白）。 */
  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const payloads: string[] = [];
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trimEnd();
      this.buf = this.buf.slice(idx + 1);
      const payload = extractDataPayload(line);
      if (payload !== null) payloads.push(payload);
      idx = this.buf.indexOf('\n');
    }
    return payloads;
  }
}

/** `data: {...}` → `{...}`；非 data 行、空 data、`[DONE]` 一律返回 null。 */
export function extractDataPayload(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const json = line.slice(5).trim();
  if (!json || json === '[DONE]') return null;
  return json;
}

/** 畸形 JSON 不是错误——半包与厂商自定义行都可能出现，跳过即可。 */
export function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 单调合并：usage 字段是累计值，多个 delta 之间取 max 而不是相加（C2 §7.4）。 */
export function mergeMax(current: number, next: unknown): number {
  return typeof next === 'number' && Number.isFinite(next) && next > current ? next : current;
}
