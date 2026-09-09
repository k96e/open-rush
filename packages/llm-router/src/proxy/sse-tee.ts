/**
 * 字节级透传 + 旁路计量（M4·T4.4，C2 §7.3，A1 / A5）。
 *
 * 三条不变量（单测逐条断言）：
 *  1. `controller.enqueue(chunk)` 传的是**同一个 Uint8Array 引用**——不拷贝、
 *     不改写、不重新分块。这是 A1「逐字节一致」与「SSE 事件不丢、顺序不变」的
 *     实现依据；也顺带保证 Claude Code 的 300s 字节看门狗看得到 `ping`。
 *  2. 先 enqueue 再 observe——旁路解析绝不占用首字节时延（TTFB）。
 *  3. observe 抛错被吞掉——A5 要求「计量失败不阻塞上层调用」。
 *
 * `onEnd` 恰好调用一次：正常 flush、客户端 cancel、上游中途出错三条路径互斥。
 */

import type { Transformer } from 'node:stream/web';

/**
 * `Transformer` 加上 `cancel` 钩子。
 *
 * WHATWG Streams 早就有 `transformer.cancel`（Node 22 实测会在下游 cancel 与上游
 * abort 两种情况下触发），但 TypeScript 目前带的 `lib.dom` / undici 类型还没补上，
 * 所以在这里补一个最小声明——不是 `any`，也不改运行时行为。
 */
interface CancelableTransformer<I, O> extends Transformer<I, O> {
  cancel?(reason: unknown): void | PromiseLike<void>;
}

export interface TeeHooks {
  onChunk(chunk: Uint8Array): void;
  /**
   * 流结束时调用，**恰好一次**。
   * `reason === undefined` 表示正常读完；有值表示被取消或上游报错（记 client_abort）。
   */
  onEnd(reason?: unknown): void;
}

export function teeForMetering(
  upstream: ReadableStream<Uint8Array>,
  hooks: TeeHooks
): ReadableStream<Uint8Array> {
  let ended = false;
  const end = (reason?: unknown): void => {
    if (ended) return;
    ended = true;
    try {
      hooks.onEnd(reason);
    } catch {
      // 旁路失败不影响主链路。
    }
  };

  const transformer: CancelableTransformer<Uint8Array, Uint8Array> = {
    transform(chunk, controller) {
      controller.enqueue(chunk); // ① 先转发：同一个对象引用
      try {
        hooks.onChunk(chunk); // ② 再旁路
      } catch {
        // 解析器炸了也要把剩下的字节转完。
      }
    },
    flush() {
      end();
    },
    cancel(reason) {
      end(reason ?? new Error('stream cancelled'));
    },
  };

  return upstream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(transformer));
}
