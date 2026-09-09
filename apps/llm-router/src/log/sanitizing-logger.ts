/**
 * 把一个 {@link RouterLogger} 包成「写什么都先过一遍清洗」的版本（M6·T6.5，A9）。
 *
 * 装在**出口**而不是各调用点：网关里会打日志的地方有访问日志、目录刷新、两道
 * 闸门降级、上游转发失败……逐个记得调 `redactLogFields` 是迟早会漏的那种约定。
 * 包一层之后，「日志里不会出现凭据」这条不变量只依赖 `server.ts` 与 `app.ts`
 * 各一处包装，而不是依赖每个作者的自觉。
 *
 * 清洗覆盖两件事：`fields` 对象里的每个字符串（含嵌套），以及 `msg` 本身。
 */
import { redactLogFields, redactSecrets } from '@open-rush/llm-router';
import type { RouterLogger } from '../deps.js';

export function sanitizingLogger(inner: RouterLogger): RouterLogger {
  const wrap =
    (level: 'info' | 'warn' | 'error') =>
    (obj: Record<string, unknown>, msg?: string): void => {
      inner[level](redactLogFields(obj), msg === undefined ? undefined : redactSecrets(msg));
    };
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}
