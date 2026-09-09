/**
 * 模型发现：`GET /v1/models`（M4·T4.5）。
 *
 * 三条硬要求（R5 §6.1）：
 *  1. **同步返回**——数据全部来自进程内的目录快照，不查库、不打上游；
 *  2. **不重定向**（含 http→https），否则 Claude Code 的模型发现会静默失败；
 *  3. 3 秒内返回——满足 1 之后自然成立。
 *
 * 返回的是**这枚令牌能用的** alias：令牌白名单之外的模型不出现在列表里，
 * 免得调用方看得见却调不动。
 */
import { isAliasAllowed } from '@open-rush/llm-router';
import { Hono } from 'hono';
import type { RouterDeps, RouterEnv } from '../deps.js';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function modelsRoutes(deps: RouterDeps): Hono<RouterEnv> {
  const app = new Hono<RouterEnv>();

  app.get('/models', (c) => {
    const snapshot = deps.catalog.current;
    const subject = c.get('subject');
    const limit = parseLimit(c.req.query('limit'));

    // 快照没加载完时回空列表而不是 500：模型发现失败会让 Claude Code 直接罢工，
    // 而 readyz 已经在摘流了，这里没必要再补一刀。
    const aliases = snapshot ? [...snapshot.byAlias.keys()].sort() : [];
    const data = aliases
      .filter((alias) => isAliasAllowed(subject, alias))
      .slice(0, limit)
      .map((alias) => {
        const model = snapshot?.byAlias.get(alias)?.[0];
        return { id: alias, display_name: model?.displayName ?? alias };
      });

    return c.json({ data });
  });

  return app;
}
