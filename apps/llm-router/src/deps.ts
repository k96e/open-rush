/**
 * 网关的依赖面（M4·T4.1）。
 *
 * 全部用**结构化接口**而不是具体类：单测可以直接塞一个内存快照和一个假认证器，
 * 不必起 PG、不必造真令牌。`server.ts` 负责把真实实现装进来。
 */
import type { CallRecorder, Snapshot, Subject } from '@open-rush/llm-router';

export interface CatalogSource {
  /** 快照未加载完时为 null——`readyz` 据此摘流。 */
  readonly current: Snapshot | null;
}

export interface SubjectAuthenticator {
  authenticate(headers: Headers): Promise<Subject | null>;
}

export interface RouterLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const SILENT_LOGGER: RouterLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface RouterDeps {
  catalog: CatalogSource;
  authenticator: SubjectAuthenticator;
  recorder: CallRecorder;
  /** 只在转发那一刻用于解封凭据；不进日志、不进响应。 */
  privateKeyPem: string;
  /**
   * 优雅退出时置 true → `readyz` 立刻 503，负载均衡摘流，在途流继续跑完（D11 / A3）。
   */
  isDraining?: () => boolean;
  logger?: RouterLogger;
}

/** Hono 的 context 变量。`subject` 由 `middleware/authenticate.ts` 写入。 */
export interface RouterEnv {
  Variables: {
    requestId: string;
    subject: Subject;
  };
}
