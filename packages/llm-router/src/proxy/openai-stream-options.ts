/**
 * OpenAI 流式的 usage 开关注入（M4·T4.6，C2 §7.4 注）。
 *
 * OpenAI 兼容协议下，流式响应**只有**在请求带 `stream_options.include_usage=true`
 * 时才会在末个 chunk 里带 usage。不注入就只能按 chunk 估算 token，A5「明细计量」
 * 直接落空。
 *
 * 这是对请求体的修改，所以：
 *  - 注入过的调用在 `llm_calls.mode` 记为 `rewrite-model`（不是 passthrough）；
 *  - A1 对这条路径只承诺「除 `model` 与 `stream_options.include_usage` 外深度相等」；
 *  - **调用方自己写了 `stream_options` 时不覆盖它**——显式关掉 usage 是调用方的
 *    选择，网关不替它改主意（这时该次调用没有 usage，按 0 记）。
 *
 * 这条取舍必须写进验收报告（M7·T7.1 的 A1 / F2 栏）。
 */

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

export interface InjectResult {
  body: Uint8Array;
  /** 是否真的改了字节。false 表示原样返回入参。 */
  injected: boolean;
}

export function injectStreamIncludeUsage(body: Uint8Array): InjectResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(body));
  } catch {
    // 非法 JSON 由路由层负责报 400，这里原样放过。
    return { body, injected: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body, injected: false };
  }
  const payload = parsed as Record<string, unknown>;

  // 调用方已经表过态（无论 true 还是 false）→ 尊重它。
  const existing = payload.stream_options;
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    if ('include_usage' in (existing as Record<string, unknown>)) return { body, injected: false };
    (existing as Record<string, unknown>).include_usage = true;
  } else if (existing !== undefined) {
    // stream_options 是个非对象的怪值：不动它，交给上游去报错。
    return { body, injected: false };
  } else {
    payload.stream_options = { include_usage: true };
  }

  return { body: ENCODER.encode(JSON.stringify(payload)), injected: true };
}
