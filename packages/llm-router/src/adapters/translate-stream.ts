/**
 * 翻译流的管道（M4·T4.7）。
 *
 * 把 {@link OpenAiToAnthropicStreamTranslator} 包成一个 `TransformStream`，并额外
 * 承担一件同协议路径上不存在的事：**自己造 `ping`**。
 *
 * Claude Code 在 `ANTHROPIC_BASE_URL` 连接上按字节计时，静默满 300 秒就中断流。
 * 真 Anthropic 上游在长思考期间靠 `ping` 事件撑着字节流，而 OpenAI 兼容上游
 * 一个 ping 都不发——翻译过来的流如果也不发，长工具参数生成或长推理过程就会被
 * 客户端判死。官方 gateway 文档对「从不发 ping 的上游」的要求就是这一条。
 *
 * 心跳是**空闲触发**而不是固定周期：只在距上一次向下游写字节超过
 * {@link DEFAULT_PING_INTERVAL_MS} 时才补一个，正常流不会被塞进多余事件。
 */
import type { Transformer } from 'node:stream/web';
import { OpenAiToAnthropicStreamTranslator } from './openai-to-anthropic.js';
import { pingEvent } from './sse.js';

/**
 * `Transformer` 加上 `cancel` 钩子。与 `proxy/sse-tee.ts` 里那份同因同源：
 * WHATWG Streams 有这个钩子，TypeScript 自带的类型还没补上。
 */
interface CancelableTransformer<I, O> extends Transformer<I, O> {
  cancel?(reason: unknown): void | PromiseLike<void>;
}

/** 默认心跳间隔。远小于 Claude Code 的 300s 看门狗，留足重试与抖动余量。 */
export const DEFAULT_PING_INTERVAL_MS = 15_000;

export interface TranslateStreamOptions {
  fallbackModel: string;
  /** 0 或负数 = 关掉心跳（单测里断言「不发多余事件」时用）。 */
  pingIntervalMs?: number;
}

export function translateOpenAiStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  opts: TranslateStreamOptions
): ReadableStream<Uint8Array> {
  const translator = new OpenAiToAnthropicStreamTranslator({ fallbackModel: opts.fallbackModel });
  const encoder = new TextEncoder();
  const pingMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;

  let controller: TransformStreamDefaultController<Uint8Array> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastWriteAt = Date.now();

  const write = (text: string): void => {
    if (!text || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
      lastWriteAt = Date.now();
    } catch {
      // 下游已经关了（客户端断开）。心跳与收尾都不该因此炸掉管道。
    }
  };

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const transformer: CancelableTransformer<Uint8Array, Uint8Array> = {
    start(ctrl) {
      controller = ctrl;
      if (pingMs <= 0) return;
      timer = setInterval(() => {
        if (Date.now() - lastWriteAt >= pingMs) write(pingEvent());
      }, pingMs);
      // 心跳不该把进程钉在事件循环里（单测与优雅退出都指望这一点）。
      (timer as { unref?: () => void }).unref?.();
    },
    transform(chunk, ctrl) {
      controller = ctrl;
      try {
        write(translator.push(chunk));
      } catch {
        // 状态机内部已经吞掉畸形输入；这里只兜住真出意外的情况，
        // 让剩下的流仍然能走完收尾（否则调用方永远等不到 message_stop）。
      }
    },
    flush(ctrl) {
      controller = ctrl;
      stopTimer();
      try {
        write(translator.end());
      } catch {
        // 同上。
      }
    },
    cancel() {
      stopTimer();
    },
  };

  return upstream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(transformer));
}
