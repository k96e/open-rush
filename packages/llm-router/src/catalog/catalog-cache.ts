/**
 * 目录快照缓存（M3·T3.2，D7 / A7 / A8）。
 *
 * 一致性模型：
 *  - DB 是唯一真相；进程内持有不可变快照 {@link Snapshot}。
 *  - 写方（控制台 API）写成功后 `version++`，**提交后**再 `pg_notify('llm_catalog', …)`
 *    （见 `bump-version.ts`）。
 *  - 读方（每个 router 副本）收到 NOTIFY 立即 refresh；另有轮询兜底，只 SELECT
 *    单行 version，**version 未变则一次目录查询都不发**（零成本）。
 *  - 已在途的请求继续用取路由时的那一份快照，不中途换供应商。
 *
 * A7/A8 的「生效时间」定义：从写事务提交，到所有健康副本的下一次路由决策使用
 * 新目录。上界 = max(NOTIFY 传播, `pollMs`) + 一次 refresh 查询耗时。
 * 默认 `pollMs = 5000` → 上界约 5s；NOTIFY 正常时应 < 500ms。
 */
import type { CatalogStore } from './catalog-store.js';
import type { Snapshot } from './types.js';

/** 与 `@open-rush/db` 的 `createNotificationListener()` 返回值结构一致（结构化类型，不 import 以免库层耦合驱动）。 */
export interface Listener {
  listen(channel: string, onNotify: (payload: string) => void): Promise<void>;
  close(): Promise<void>;
}

export type RefreshTrigger = 'boot' | 'notify' | 'poll';

export interface CatalogCacheLogger {
  warn(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
}

export interface CatalogCacheOptions {
  /** 轮询兜底间隔，默认 5000ms。 */
  pollMs?: number;
  onRefresh?: (snapshot: Snapshot, trigger: RefreshTrigger) => void;
  logger?: CatalogCacheLogger;
}

/** LISTEN/NOTIFY 的频道名。与 `bump-version.ts` 的 `LLM_CATALOG_CHANNEL` 同值。 */
export const CATALOG_CHANNEL = 'llm_catalog';

export class CatalogCache {
  private snapshot: Snapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 并发去重：正在跑的那次 refresh，多个 NOTIFY 同时到达只跑一次。 */
  private refreshing: Promise<void> | null = null;
  /**
   * 在途刷新期间又来了通知 → 结束后**补跑一次**。
   *
   * 单纯的去重会漏掉这种交错：refresh 已经读完版本位，此刻写事务才提交并发出
   * NOTIFY，那次通知被合并进一个「已经看不到它」的刷新里，变更要等到下一次轮询
   * （最坏 pollMs）才生效。补跑一次把 NOTIFY 路径的时延重新压回百毫秒级，
   * 且补跑本身在版本没动时是零成本的（只 SELECT 版本位）。
   */
  private pending = false;
  private stopped = false;

  constructor(
    private readonly store: CatalogStore,
    private readonly listener: Listener | null,
    private readonly opts: CatalogCacheOptions = {}
  ) {}

  /**
   * 首次加载 + 订阅 + 起轮询。
   *
   * boot 那次 refresh 失败**不抛**——`current` 仍是 null，`readyz` 会因此摘流，
   * 而轮询会继续尝试。启动期 DB 抖动不该让进程直接退出（D11）。
   */
  async start(): Promise<void> {
    await this.refresh('boot');

    if (this.listener) {
      // listen 失败不致命——轮询兜底仍在，只是生效时延退化到 pollMs。
      await this.listener
        .listen(CATALOG_CHANNEL, () => {
          void this.refresh('notify');
        })
        .catch((err) => this.opts.logger?.warn('[catalog] LISTEN failed, polling only', err));
    }

    const pollMs = this.opts.pollMs ?? 5_000;
    this.timer = setInterval(() => {
      void this.refresh('poll');
    }, pollMs);
    // 只有轮询定时器时不该拖住进程退出。
    this.timer.unref?.();
  }

  /**
   * 刷新一次。并发调用共享同一个在途 Promise。
   *
   * 失败时**保留旧快照**继续服务——DB 抖动期间网关按上一份目录照常工作
   * （可用性优先，A3）。
   */
  private refresh(trigger: RefreshTrigger): Promise<void> {
    if (this.refreshing) {
      this.pending = true;
      return this.refreshing;
    }

    const run = (async () => {
      try {
        const version = await this.store.readVersion();
        // 版本没动 → 直接返回，不发目录查询。轮询的零成本性质就靠这一句。
        if (this.snapshot && this.snapshot.version === version) return;

        const next = await this.store.loadSnapshot(version);
        this.snapshot = next;
        this.opts.onRefresh?.(next, trigger);
        this.opts.logger?.info('[catalog] refreshed', {
          trigger,
          version,
          models: next.byAlias.size,
          providers: next.providers.size,
        });
      } catch (err) {
        this.opts.logger?.warn('[catalog] refresh failed, keeping previous snapshot', err);
      } finally {
        this.refreshing = null;
      }

      // 补跑最多一次——刷新期间攒下的通知合并成这一次，不会滚成循环。
      if (this.pending && !this.stopped) {
        this.pending = false;
        await this.refresh(trigger);
      }
    })();

    this.refreshing = run;
    return run;
  }

  /** 手动触发一次刷新（测试与 `/admin/reload` 之类的入口用）。 */
  async forceRefresh(): Promise<void> {
    await this.refresh('notify');
  }

  /** `readyz` 依赖它：快照未加载完不接流量。 */
  get current(): Snapshot | null {
    return this.snapshot;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.listener?.close();
  }
}
