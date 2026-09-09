/**
 * A1 的唯一例外（M4·T4.3，C4 §7.10，D2b）。
 *
 * `alias === upstreamModel` 时走 passthrough，请求体一个字节都不动。异名时才走
 * 这里，而且**只允许改顶层 `model` 一个字段**——单测用深度相等断言把这条钉死。
 *
 * 副作用是重新序列化：键顺序保持不变（V8 的对象键序 = 插入序），但空白与转义
 * 会被规范化。所以 rewrite 模式**不承诺字节一致**，只承诺「除 model 外语义等价」。
 * 这正是 R2 §3.1 三档承诺里的第二档。
 */

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

export class ModelRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRewriteError';
  }
}

export function rewriteModelField(body: Uint8Array, upstreamModel: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(body));
  } catch (err) {
    throw new ModelRewriteError(`request body is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ModelRewriteError('request body must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  obj.model = upstreamModel;
  return ENCODER.encode(JSON.stringify(obj));
}
