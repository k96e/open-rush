/**
 * 批写器（M5·T5.1）。A5 的三条硬要求逐条钉死：
 *  ① `enqueue` 同步、不抛——哪怕 store 每次都炸；
 *  ② 队列有界，满了丢最老的（绝不 OOM）；
 *  ③ flush 失败**不回队**，只计数告警（回队会在故障期无限重放）。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeCallRecord } from '../../../test/call-records.js';
import type { CallRecord } from '../call-record.js';
import { BatchingCallRecorder } from '../call-recorder.js';
import type { CallStore } from '../call-store.js';

class FakeStore implements CallStore {
  readonly batches: CallRecord[][] = [];
  failures = 0;

  constructor(private readonly failing = false) {}

  async insertBatchWithBudget(batch: readonly CallRecord[]): Promise<void> {
    if (this.failing) {
      this.failures += 1;
      throw new Error('db is down');
    }
    this.batches.push([...batch]);
  }
}

describe('BatchingCallRecorder', () => {
  it('enqueue 不落库，flush 才落', async () => {
    const store = new FakeStore();
    const recorder = new BatchingCallRecorder(store, { batchSize: 10 });
    recorder.enqueue(makeCallRecord());
    expect(store.batches).toHaveLength(0);
    expect(recorder.stats().pending).toBe(1);

    await recorder.flush();
    expect(store.batches).toEqual([[expect.objectContaining({ modelAlias: 'claude-sonnet-4-6' })]]);
    expect(recorder.stats()).toMatchObject({ pending: 0, written: 1, dropped: 0 });
  });

  it('攒够 batchSize 自动 flush', async () => {
    const store = new FakeStore();
    const recorder = new BatchingCallRecorder(store, { batchSize: 3 });
    for (let i = 0; i < 3; i++) recorder.enqueue(makeCallRecord());
    await recorder.flush(); // 等自动触发的那一次串行完
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]).toHaveLength(3);
  });

  it('一批只取 batchSize 条，剩下的留到下一轮', async () => {
    const store = new FakeStore();
    const recorder = new BatchingCallRecorder(store, { batchSize: 2 });
    for (let i = 0; i < 5; i++) recorder.enqueue(makeCallRecord());
    await recorder.drain();
    expect(store.batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('★ store 抛错时 enqueue / flush 都不抛给调用方，dropped 递增且不回队', async () => {
    const store = new FakeStore(true);
    const onError = vi.fn();
    const recorder = new BatchingCallRecorder(store, { batchSize: 2, onError });

    expect(() => {
      recorder.enqueue(makeCallRecord());
      recorder.enqueue(makeCallRecord());
    }).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();

    expect(recorder.stats()).toMatchObject({ pending: 0, dropped: 2, failures: 1, written: 0 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe(2);
    // 不回队：再 flush 一次不会重放同一批。
    await recorder.flush();
    expect(store.failures).toBe(1);
  });

  it('告警回调自己抛错也不影响计量循环', async () => {
    const recorder = new BatchingCallRecorder(new FakeStore(true), {
      batchSize: 1,
      onError: () => {
        throw new Error('logger exploded');
      },
    });
    recorder.enqueue(makeCallRecord());
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(recorder.stats().dropped).toBe(1);
  });

  it('★ 队列满时丢最老的，长度不再增长', async () => {
    const store = new FakeStore();
    // batchSize 大于 maxQueue，避免自动 flush 干扰这条断言。
    const recorder = new BatchingCallRecorder(store, { batchSize: 100, maxQueue: 3 });
    for (let i = 0; i < 5; i++) recorder.enqueue(makeCallRecord({ requestId: `req-${i}` }));

    expect(recorder.stats()).toMatchObject({ pending: 3, dropped: 2 });
    await recorder.flush();
    expect(store.batches[0].map((r) => r.requestId)).toEqual(['req-2', 'req-3', 'req-4']);
  });

  it('定时器到点自动 flush，且 drain 之后不再触发', async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      const recorder = new BatchingCallRecorder(store, { batchSize: 100, flushIntervalMs: 50 });
      recorder.start();
      recorder.enqueue(makeCallRecord());

      await vi.advanceTimersByTimeAsync(60);
      expect(store.batches).toHaveLength(1);

      await recorder.drain();
      recorder.enqueue(makeCallRecord());
      await vi.advanceTimersByTimeAsync(200);
      expect(store.batches).toHaveLength(1); // 定时器已停
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() 幂等：调两次只有一个定时器', async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      const recorder = new BatchingCallRecorder(store, { batchSize: 100, flushIntervalMs: 50 });
      recorder.start();
      recorder.start();
      recorder.enqueue(makeCallRecord());
      await vi.advanceTimersByTimeAsync(60);
      expect(store.batches).toHaveLength(1);
      await recorder.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drain 清空队列；store 一直失败时也一定终止', async () => {
    const recorder = new BatchingCallRecorder(new FakeStore(true), { batchSize: 2 });
    for (let i = 0; i < 5; i++) recorder.enqueue(makeCallRecord());
    await recorder.drain();
    expect(recorder.stats()).toMatchObject({ pending: 0, dropped: 5 });
  });

  it('flush 串行化：并发调用不会把同一条记录写两次', async () => {
    const store = new FakeStore();
    const recorder = new BatchingCallRecorder(store, { batchSize: 100 });
    for (let i = 0; i < 3; i++) recorder.enqueue(makeCallRecord({ requestId: `req-${i}` }));
    await Promise.all([recorder.flush(), recorder.flush(), recorder.flush()]);

    const written = store.batches.flat().map((r) => r.requestId);
    expect(written.sort()).toEqual(['req-0', 'req-1', 'req-2']);
  });

  it('空队列 flush 是 no-op，不打扰 store', async () => {
    const store = new FakeStore();
    await new BatchingCallRecorder(store).flush();
    expect(store.batches).toHaveLength(0);
  });
});
