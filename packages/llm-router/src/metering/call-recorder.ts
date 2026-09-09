/**
 * 异步批写的计量写入器（M5·T5.1，C6 §7.11）。
 *
 * A5 的硬性要求落成三条机制，每条都有对应单测：
 *  - `enqueue()` **同步、无 await、不抛错**——转发路径既不等它也不 catch 它；
 *  - 队列**有界**，满了丢最老的：故障期宁可丢计量，绝不 OOM 把网关拖垮；
 *  - flush 失败**不回队**——回队会在 DB 故障期无限重放，把一次抖动放大成雪崩。
 *    丢弃 + 计数 + 告警，`stats().dropped` 就是这段时间的损失量。
 *
 * 类名不叫 `CallRecorder`：那个名字在 M4 已经是接口名（`metering/call-record.ts`），
 * 转发路径依赖的是接口。这里是它的「攒批落库」实现。
 */
import type { CallRecord, CallRecorder } from './call-record.js';
import type { CallStore } from './call-store.js';

export interface BatchingCallRecorderOptions {
  /** 攒够就立刻 flush（也是单次事务的行数上限）。 */
  batchSize?: number;
  /** 定时 flush 间隔。 */
  flushIntervalMs?: number;
  /** 队列容量上限。超出后丢最老的。 */
  maxQueue?: number;
  /** flush 失败时的告警回调。**必须自己不抛**——这里不会再兜一层。 */
  onError?: (err: unknown, batchSize: number) => void;
}

export interface CallRecorderStats {
  /** 还在内存队列里、尚未落库的条数。 */
  pending: number;
  /** 因队列满或 flush 失败而永久丢弃的条数。 */
  dropped: number;
  /** 已成功落库的条数。 */
  written: number;
  /** flush 失败的次数（批次数，不是条数）。 */
  failures: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_QUEUE = 10_000;

export class BatchingCallRecorder implements CallRecorder {
  private readonly queue: CallRecord[] = [];
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueue: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  private written = 0;
  private failures = 0;
  /**
   * flush 串行化。定时器与 `enqueue` 的攒满触发可能同时到，两个事务并发写同一批
   * 累计器行会互相等锁；串起来还顺带保证了落库顺序与入队顺序一致。
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: CallStore,
    private readonly opts: BatchingCallRecorderOptions = {}
  ) {
    this.batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    this.flushIntervalMs = Math.max(1, opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
  }

  /** 启动定时 flush。`unref()` 让它不阻止进程退出。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** 同步、不抛、不 await。转发路径唯一的计量入口。 */
  enqueue(record: CallRecord): void {
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  /** 落一批。**永不抛**——失败只计数与告警。 */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.flushOnce());
    return this.chain;
  }

  private async flushOnce(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize);
    try {
      await this.store.insertBatchWithBudget(batch);
      this.written += batch.length;
    } catch (err) {
      this.dropped += batch.length;
      this.failures += 1;
      try {
        this.opts.onError?.(err, batch.length);
      } catch {
        // 告警回调自己炸了也不能反过来影响计量循环。
      }
    }
  }

  /**
   * 优雅退出：停掉定时器，把队列排空后再返回。
   *
   * 每一轮都会从队列里摘走一批（不论成败），所以即便 store 持续失败也一定终止。
   */
  async drain(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) await this.flush();
    await this.chain;
  }

  stats(): CallRecorderStats {
    return {
      pending: this.queue.length,
      dropped: this.dropped,
      written: this.written,
      failures: this.failures,
    };
  }
}
