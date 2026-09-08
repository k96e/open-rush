import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let _client: ReturnType<typeof postgres> | null = null;
let _db: DbClient | null = null;
let _url: string | null = null;

export function parsePoolMax(raw: string | undefined): number {
  if (!raw) return 10;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 10;
  return Math.min(n, 100);
}

export function formatDatabaseUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
  }
}

export function getDbClient(connectionString?: string): DbClient {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set and no connection string provided');
  }

  if (_db) {
    if (_url && _url !== url) {
      throw new Error(
        `getDbClient called with different URL. Existing: ${formatDatabaseUrlForLog(_url)}, Requested: ${formatDatabaseUrlForLog(url)}. Call closeDbClient() first.`
      );
    }
    return _db;
  }

  _url = url;
  _client = postgres(url, {
    max: parsePoolMax(process.env.DB_POOL_MAX),
    idle_timeout: 30,
    connect_timeout: 10,
  });

  _db = drizzle(_client, { schema });
  return _db;
}

/**
 * 一个只用于 LISTEN/NOTIFY 的连接句柄。
 *
 * 与 `getDbClient()` 的连接池分开：`LISTEN` 会**独占**一条连接直到取消订阅，
 * 若从池里借用会把池慢慢掏空。所以这里单独开 `postgres(url, { max: 1 })`。
 */
export interface NotificationListener {
  /** 订阅一个 channel。断线后 postgres.js 会自动重连并重新订阅。 */
  listen(channel: string, onNotify: (payload: string) => void): Promise<void>;
  /** 关闭连接。幂等，且**永不 reject**——关闭期的错误无从补救，只会掩盖真正的失败原因。 */
  close(): Promise<void>;
}

/**
 * 创建一个专用于 LISTEN/NOTIFY 的独立连接（max: 1）。
 *
 * 用于 llm-router 的目录热变更（specs/llm-router.md §热变更）：
 * 写方在事务内 `version++`、提交后 `pg_notify('llm_catalog', version)`，
 * 各副本靠本监听器即时刷新目录快照，另有轮询兜底。
 *
 * 连接是惰性的——本函数只构造句柄，真正建连发生在首次 `listen()`。
 * `idle_timeout: 0` 表示不因空闲断开：监听连接大部分时间都是空闲的。
 *
 * ⚠️ `listen()` 失败（例如启动时 DB 不可达）不会自动收摊：postgres.js 的重连
 * 循环仍在跑。**调用方在失败路径上也要负责 `close()`**——C3 §7.6 的
 * `CatalogCache.start()` 把 listen 的 rejection 吞成一条 warn，若不显式关闭，
 * 一个对着挂掉的 DB 启动的副本会一直挂着这条重连中的孤儿连接。
 */
export function createNotificationListener(connectionString?: string): NotificationListener {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set and no connection string provided');
  }

  const sql = postgres(url, { max: 1, idle_timeout: 0, connect_timeout: 10 });
  let closing: Promise<void> | null = null;

  return {
    async listen(channel: string, onNotify: (payload: string) => void): Promise<void> {
      if (closing) {
        throw new Error('NotificationListener is closed');
      }
      await sql.listen(channel, onNotify);
    },
    async close(): Promise<void> {
      // 幂等：重复 close() 复用同一个 Promise，不会向已关闭的连接再发一次 end。
      // 吞掉 end() 的错误——否则被记住的 rejection 会让之后每一次 close() 都抛，
      // 与「多次调用安全」自相矛盾。
      closing ??= sql.end({ timeout: 5 }).catch(() => undefined);
      await closing;
    },
  };
}

export async function closeDbClient(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
    _url = null;
  }
}
