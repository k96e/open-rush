/**
 * 日志清洗（M6·T6.5，A9）。
 *
 * 网关自己的四字段访问日志（method/path/status/requestId）本来没有可泄漏的内容，
 * 真正的风险在**别处进来的字符串**：目录刷新的告警里带 provider 名、上游转发
 * 失败的 `err` 里带 URL 与响应片段。这些值由控制台配置或上游返回，谁也拦不住
 * 有人把一段 `sk-ant-…` 填进 provider name。
 *
 * 与 `packages/control-plane` 的 `vault/output-sanitizer.ts` 是**同一套模式表加两条**：
 * 没有直接复用是因为 control-plane 拖着 mcp / memory / sandbox / skills 四个包，
 * 为一个正则表把它们全打进网关镜像，与「极薄」正相反（M4 已经为同一理由拒绝过
 * 这条依赖）。加的两条是网关特有的：
 *  - `rt_…` —— 网关自己签发的调用方令牌，最可能出现在网关日志里的那一种凭据；
 *  - `Bearer …` / `x-api-key: …` —— 万一有人把整个请求头 dump 进日志。
 */

const REDACTED = '[REDACTED]';

/** 每条都必须带 `g`：下面用 `String.replace` 逐条全量替换。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // —— 与 control-plane 的 output-sanitizer 对齐的 6 条 ——
  /AKIA[A-Z0-9]{16}/g,
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
  /sk-(?:proj-)?[a-zA-Z0-9\-_]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  /ghs_[a-zA-Z0-9]{36,}/g,
  // —— 网关特有 ——
  /rt_[A-Za-z0-9\-_]{20,}/g,
  /\b(?:Bearer|bearer)\s+[A-Za-z0-9\-._~+/]{16,}=*/g,
];

/** 值需要整体打码的键（大小写不敏感、只看键名本身）。 */
const SECRET_KEY_RE = /^(?:authorization|x-api-key|api[-_]?key|token|secret|password|credential)$/i;

/** 对付「一段极长的 base64 里藏着密钥」这类输入：先截断再匹配没有意义，所以只限深度。 */
const MAX_DEPTH = 6;

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

export function containsSecrets(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * 深度清洗一个准备进日志的值。
 *
 * - 字符串 → 逐条正则替换
 * - 对象 / 数组 → 递归（超过 {@link MAX_DEPTH} 层就整体转成字符串再洗，
 *   免得一个自引用结构把日志线程转死）
 * - 键名命中 {@link SECRET_KEY_RE} → 值整体换成 `[REDACTED]`，不管它长什么样
 * - 其余（number / boolean / null / undefined）→ 原样
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return redactSecrets(safeStringify(value));
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value instanceof Error) return redactSecrets(`${value.name}: ${value.message}`);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

/** 顶层入口：日志对象一定是 `Record<string, unknown>`。 */
export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields) as Record<string, unknown>;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
