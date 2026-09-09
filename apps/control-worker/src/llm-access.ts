/**
 * llm-router 接入的装配（M6·T6.4）。
 *
 * **`LLM_ROUTER_BASE_URL` 未设置 = 不装配**，`RunOrchestrator` 于是退化为改造前
 * 行为（不签发令牌、沙箱 env 里没有 `ANTHROPIC_*`、不聚合用量、不吊销）。
 * 这是灰度与回滚开关：先把网关跑起来、确认目录与凭据都对了，再设这个变量。
 *
 * 不装配时打一条 warn 而不是静默——「以为接上了其实没接」是这条链路最贵的误判，
 * dev 下的表现是「Claude Code 还在直连供应商」，看日志才分得出来。
 */
import {
  DrizzleRouterTokenStore,
  LlmAccessService,
  type RouterTokenStore,
} from '@open-rush/control-plane';
import type { DbClient } from '@open-rush/db';

export interface LlmAccessEnv {
  LLM_ROUTER_BASE_URL?: string;
  LLM_ROUTER_TOKEN_TTL_SECONDS?: string;
}

export interface LlmAccessLogger {
  warn(message: string): void;
  info(message: string): void;
}

/**
 * @param storeFactory 测试用的注入点。默认就是真 store；单测换成假的之后，
 *   「地址与 TTL 解析对不对」这件事可以从 `issueForRun` 的返回值上直接看出来，
 *   不必去戳 service 的私有字段。
 */
export function createLlmAccess(
  db: DbClient,
  env: LlmAccessEnv = process.env,
  logger: LlmAccessLogger = console,
  storeFactory: (db: DbClient) => RouterTokenStore = (d) => new DrizzleRouterTokenStore(d)
): LlmAccessService | undefined {
  const routerBaseUrl = env.LLM_ROUTER_BASE_URL?.trim();
  if (!routerBaseUrl) {
    logger.warn(
      '[llm-access] LLM_ROUTER_BASE_URL not set — runs will NOT go through llm-router ' +
        '(no per-run token, no metering). Set it to enable the gateway.'
    );
    return undefined;
  }

  const ttl = Number(env.LLM_ROUTER_TOKEN_TTL_SECONDS);
  const defaultTtlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : undefined;

  logger.info(`[llm-access] llm-router enabled at ${routerBaseUrl}`);
  return new LlmAccessService(storeFactory(db), { routerBaseUrl, defaultTtlSeconds });
}
