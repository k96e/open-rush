/**
 * 明文泄漏探针（M7·T7.1 / T7.3 的 TS 侧，A9 / A11）。
 *
 * 判定口径刻意做得比「grep 一下」严：**同时**查明文本身与它的 base64 形态。
 * 泄漏最常见的形态不是有人 `console.log(key)`，而是某个中间层把整个凭据对象
 * JSON 化再 base64 一下丢进日志——只 grep 明文会漏掉那一类。
 */

export interface ProbeResult {
  name: string;
  leaked: boolean;
  /** 命中的形态：明文 / base64 / 无。 */
  form: 'plaintext' | 'base64' | 'none';
  /** 命中位置前后的一小段，**已把密钥本身抹掉**，只用来定位。 */
  excerpt?: string;
}

/** 密钥太短时 base64 片段容易误命中，低于这个长度只查明文。 */
const MIN_BASE64_PROBE_LEN = 12;

export function probeForSecret(name: string, haystack: string, secret: string): ProbeResult {
  if (!secret) throw new Error('probeForSecret: secret must not be empty');

  const plainAt = haystack.indexOf(secret);
  if (plainAt >= 0) {
    return {
      name,
      leaked: true,
      form: 'plaintext',
      excerpt: excerptAround(haystack, plainAt, secret),
    };
  }

  if (secret.length >= MIN_BASE64_PROBE_LEN) {
    // base64 有三种对齐相位，取中间一段避开首尾的填充差异。
    for (const offset of [0, 1, 2]) {
      const encoded = Buffer.from(secret.slice(offset), 'utf8')
        .toString('base64')
        .replace(/=+$/, '');
      const probe = encoded.slice(4, encoded.length - 4);
      if (probe.length < 8) continue;
      const at = haystack.indexOf(probe);
      if (at >= 0) {
        return { name, leaked: true, form: 'base64', excerpt: excerptAround(haystack, at, probe) };
      }
    }
  }

  return { name, leaked: false, form: 'none' };
}

/** 命中处前后各 40 字符，命中的那一段替换成 `<REDACTED>`——报告可以贴出来。 */
export function excerptAround(haystack: string, at: number, needle: string): string {
  const from = Math.max(0, at - 40);
  const to = Math.min(haystack.length, at + needle.length + 40);
  const slice = haystack.slice(from, to);
  return slice.split(needle).join('<REDACTED>').replace(/\s+/g, ' ');
}

export function allClean(results: readonly ProbeResult[]): boolean {
  return results.every((r) => !r.leaked);
}

export function renderProbes(results: readonly ProbeResult[]): string[] {
  return results.map((r) =>
    r.leaked ? `LEAK(${r.form}) in ${r.name}: ${r.excerpt ?? ''}` : `clean: ${r.name}`
  );
}
