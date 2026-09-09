/**
 * 上下游请求头的处理（M4·T4.3，C4 §7.9，R5 §6.1）。
 *
 * **开放列表原则，不做白名单过滤。** `anthropic-beta` 的取值集合随 Claude Code
 * 版本增长，任何白名单都会在新版本发布的那天静默打断新能力——而且是「功能悄悄
 * 不生效」而不是「报错」，最难查。所以这里只列**必须拦下的**几类：
 *  - hop-by-hop：转发出去会破坏连接语义；
 *  - CONSUME_ONLY：网关自己消费掉的（router 令牌、分组提示、我们要重写的头）。
 * 其余一律放行。
 */
import type { ResolvedRoute } from '../catalog/types.js';

/** RFC 9110 的逐跳头 + 由 fetch 自行计算的 host / content-length。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/**
 * 调用方发来的、**绝不转发上游**的头。
 *
 * - `authorization` / `x-api-key`：这是 router 令牌，转出去等于把网关凭据送给供应商；
 * - `x-claude-code-*`：只作分组提示记进 `llm_calls.cc_*`（D6），不必外泄会话结构；
 * - `x-request-id`：换成网关自己生成的 id，便于两侧日志对齐；
 * - `accept-encoding`：强制 `identity`，见下。
 */
const CONSUME_ONLY = new Set([
  'authorization',
  'x-api-key',
  'x-claude-code-session-id',
  'x-claude-code-agent-id',
  'x-claude-code-parent-agent-id',
  'x-request-id',
  'accept-encoding',
]);

/** `x-claude-code-*` 里被消费掉、记进 `llm_calls` 的两个。 */
export function extractGroupingHints(inbound: Headers): {
  ccSessionId: string | null;
  ccAgentId: string | null;
} {
  return {
    ccSessionId: inbound.get('x-claude-code-session-id'),
    ccAgentId: inbound.get('x-claude-code-agent-id'),
  };
}

export function buildUpstreamHeaders(
  inbound: Headers,
  route: ResolvedRoute,
  apiKey: string | null,
  requestId: string
): Headers {
  const out = new Headers();
  for (const [key, value] of inbound) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || CONSUME_ONLY.has(lower)) continue;
    out.set(key, value);
  }

  // 不请求压缩：一旦上游返回 gzip，我们要么解压（字节就变了）、要么原样透传但
  // 无法旁路解析 usage。强制 identity 让「逐字节一致」和「计量」同时成立。
  out.set('accept-encoding', 'identity');
  out.set('x-request-id', requestId);

  // provider 的默认头**后于**调用方头写入：运营配置优先于客户端传来的同名头。
  for (const [key, value] of Object.entries(route.provider.defaultHeaders)) out.set(key, value);

  if (apiKey) {
    switch (route.credential?.authStyle) {
      case 'x-api-key':
        out.set('x-api-key', apiKey);
        break;
      case 'header':
        // authStyle='header' 时 authHeader 必填（DB 有 CHECK 约束兜底）。
        if (route.credential.authHeader) out.set(route.credential.authHeader, apiKey);
        break;
      default:
        out.set('authorization', `Bearer ${apiKey}`);
    }
  }
  return out;
}

/**
 * 上游响应头 → 下游。除 hop-by-hop 外还要剥三类：
 *
 *  - `authorization` / `x-api-key`：有些上游（尤其是自建网关）会把认证头回显在
 *    响应里，透传出去就是一次密钥泄漏；
 *  - `content-encoding`：我们向上游发的是 `accept-encoding: identity`，但上游
 *    仍然可能压缩。而 undici 的 fetch **会自动解压**——此时手上的字节已经是明文，
 *    再把 `content-encoding: gzip` 转给调用方，客户端会拿解压过的字节再解一次，
 *    直接解析失败。头与 body 必须自洽，所以这里剥掉它。
 */
export function stripHopByHop(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'authorization' || lower === 'x-api-key') continue;
    if (lower === 'content-encoding') continue;
    out.set(key, value);
  }
  return out;
}
