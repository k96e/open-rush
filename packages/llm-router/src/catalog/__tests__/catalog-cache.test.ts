/**
 * CatalogCache 单测（M3·T3.2）。
 *
 * 用假 store + 假 listener，因为本阶段要断言的大多是「**没有**发生的查询」：
 *  - version 未变时一次 loadSnapshot 都不发（轮询的零成本性质）
 *  - 并发 refresh 只跑一次
 *  - loadSnapshot 抛错时旧快照仍在服务
 *  - stop() 之后定时器不再触发
 * 这些命题在真库上测不出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_CHANNEL, CatalogCache, type Listener } from '../catalog-cache.js';
import type { CatalogStore } from '../catalog-store.js';
import type { Snapshot } from '../types.js';

function snapshotOf(version: number): Snapshot {
  return {
    version,
    loadedAt: new Date(),
    byAlias: new Map(),
    providers: new Map(),
    credentials: new Map(),
  };
}

/** 版本位可写的假 store，`loadSnapshot` 返回当前版本的空快照。 */
function fakeStore(initialVersion = 1) {
  let version = initialVersion;
  const readVersion = vi.fn(async () => version);
  const loadSnapshot = vi.fn(async (v: number) => snapshotOf(v));
  const store: CatalogStore = { readVersion, loadSnapshot };
  return {
    store,
    readVersion,
    loadSnapshot,
    setVersion(v: number) {
      version = v;
    },
  };
}

function fakeListener() {
  let handler: ((payload: string) => void) | null = null;
  const listen = vi.fn(async (_channel: string, onNotify: (payload: string) => void) => {
    handler = onNotify;
  });
  const close = vi.fn(async () => {});
  const listener: Listener = { listen, close };
  return {
    listener,
    listen,
    close,
    notify(payload = '2') {
      handler?.(payload);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CatalogCache.start', () => {
  it('loads a snapshot on boot and subscribes to the catalog channel', async () => {
    const { store, loadSnapshot } = fakeStore(5);
    const { listener, listen } = fakeListener();
    const cache = new CatalogCache(store, listener);

    await cache.start();

    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(cache.current?.version).toBe(5);
    expect(listen).toHaveBeenCalledWith(CATALOG_CHANNEL, expect.any(Function));
    await cache.stop();
  });

  it('keeps polling when LISTEN fails (degrades, does not throw)', async () => {
    const { store, loadSnapshot, setVersion } = fakeStore(1);
    const listener: Listener = {
      listen: vi.fn(async () => {
        throw new Error('no connection');
      }),
      close: vi.fn(async () => {}),
    };
    const warn = vi.fn();
    const cache = new CatalogCache(store, listener, {
      pollMs: 1000,
      logger: { warn, info: vi.fn() },
    });

    await expect(cache.start()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    setVersion(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    await cache.stop();
  });

  it('leaves current null when the boot load fails, without throwing', async () => {
    const store: CatalogStore = {
      readVersion: vi.fn(async () => {
        throw new Error('db down');
      }),
      loadSnapshot: vi.fn(),
    };
    const cache = new CatalogCache(store, null);

    await expect(cache.start()).resolves.toBeUndefined();
    expect(cache.current).toBeNull();
    await cache.stop();
  });
});

describe('CatalogCache polling', () => {
  it('does not call loadSnapshot when the version has not changed', async () => {
    const { store, readVersion, loadSnapshot } = fakeStore(3);
    const cache = new CatalogCache(store, null, { pollMs: 1000 });
    await cache.start();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);

    // 三次轮询：只读了版本位，一次目录查询都没发。
    expect(readVersion).toHaveBeenCalledTimes(4);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    await cache.stop();
  });

  it('reloads when the version moves', async () => {
    const { store, loadSnapshot, setVersion } = fakeStore(1);
    const onRefresh = vi.fn();
    const cache = new CatalogCache(store, null, { pollMs: 1000, onRefresh });
    await cache.start();

    setVersion(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(loadSnapshot).toHaveBeenLastCalledWith(2);
    expect(cache.current?.version).toBe(2);
    expect(onRefresh).toHaveBeenLastCalledWith(expect.objectContaining({ version: 2 }), 'poll');
    await cache.stop();
  });
});

describe('CatalogCache NOTIFY', () => {
  it('refreshes on notify', async () => {
    const { store, loadSnapshot, setVersion } = fakeStore(1);
    const { listener, notify } = fakeListener();
    const onRefresh = vi.fn();
    const cache = new CatalogCache(store, listener, { pollMs: 60_000, onRefresh });
    await cache.start();

    setVersion(2);
    notify('2');
    await vi.advanceTimersByTimeAsync(0);

    expect(loadSnapshot).toHaveBeenLastCalledWith(2);
    expect(onRefresh).toHaveBeenLastCalledWith(expect.objectContaining({ version: 2 }), 'notify');
    await cache.stop();
  });

  it('re-runs once when a notify lands mid-refresh (the interleaving dedupe alone would drop)', async () => {
    let version = 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readVersion = vi.fn(async () => version);
    const loadSnapshot = vi.fn(async (v: number) => {
      // 只卡住 version=2 那次加载，好让第二条 NOTIFY 在它在途时到达。
      if (v === 2) await gate;
      return snapshotOf(v);
    });
    const { listener, notify } = fakeListener();
    const cache = new CatalogCache({ readVersion, loadSnapshot }, listener, { pollMs: 60_000 });
    await cache.start();

    version = 2;
    notify('2');
    await vi.advanceTimersByTimeAsync(0);

    // 在途刷新已经读过版本位；写事务此刻才提交并发出第二条 NOTIFY。
    version = 3;
    notify('3');
    release();
    await vi.advanceTimersByTimeAsync(0);

    // 补跑那次看到了 version=3——没有它就要等到下一次轮询（最坏 pollMs）。
    expect(cache.current?.version).toBe(3);
    await cache.stop();
  });

  it('dedupes concurrent refreshes into a single load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readVersion = vi.fn(async () => 2);
    const loadSnapshot = vi.fn(async (v: number) => {
      await gate;
      return snapshotOf(v);
    });
    const cache = new CatalogCache({ readVersion, loadSnapshot }, null, { pollMs: 60_000 });

    // 三次并发 refresh（start 那次 + 两次「NOTIFY」）应当只产生一次加载。
    const inflight = Promise.all([cache.start(), cache.forceRefresh(), cache.forceRefresh()]);
    release();
    await inflight;

    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    await cache.stop();
  });
});

describe('CatalogCache failure handling', () => {
  it('keeps serving the previous snapshot when a refresh fails', async () => {
    let version = 1;
    let failing = false;
    const store: CatalogStore = {
      readVersion: vi.fn(async () => version),
      loadSnapshot: vi.fn(async (v: number) => {
        if (failing) throw new Error('db flaked');
        return snapshotOf(v);
      }),
    };
    const warn = vi.fn();
    const cache = new CatalogCache(store, null, {
      pollMs: 1000,
      logger: { warn, info: vi.fn() },
    });
    await cache.start();
    expect(cache.current?.version).toBe(1);

    failing = true;
    version = 2;
    await vi.advanceTimersByTimeAsync(1000);

    expect(cache.current?.version).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[catalog] refresh failed, keeping previous snapshot',
      expect.any(Error)
    );

    // 抖动结束后自愈——refreshing 没有被卡住。
    failing = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(cache.current?.version).toBe(2);
    await cache.stop();
  });
});

describe('CatalogCache.stop', () => {
  it('clears the poll timer and closes the listener', async () => {
    const { store, readVersion } = fakeStore(1);
    const { listener, close } = fakeListener();
    const cache = new CatalogCache(store, listener, { pollMs: 1000 });
    await cache.start();

    await cache.stop();
    const callsAfterStop = readVersion.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(readVersion).toHaveBeenCalledTimes(callsAfterStop);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is safe to call twice', async () => {
    const { store } = fakeStore(1);
    const { listener, close } = fakeListener();
    const cache = new CatalogCache(store, listener, { pollMs: 1000 });
    await cache.start();

    await cache.stop();
    await expect(cache.stop()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
