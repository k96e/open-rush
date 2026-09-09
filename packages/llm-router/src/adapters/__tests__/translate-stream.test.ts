/**
 * 翻译流的管道（M4·T4.7）：状态机接上真的 `ReadableStream`，外加心跳。
 *
 * 心跳这条是**功能性要求而不是锦上添花**：Claude Code 在 `ANTHROPIC_BASE_URL`
 * 连接上按字节计时，静默 300 秒就中断；OpenAI 上游一个 ping 都不发。
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PING_INTERVAL_MS, translateOpenAiStreamToAnthropic } from '../translate-stream.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function sourceOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(ENCODER.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += DECODER.decode(value, { stream: true });
  }
  return out;
}

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

/** 一个可以手动喂数据、手动结束的上游流（用来制造「长时间沉默」）。 */
function controlledSource(): {
  stream: ReadableStream<Uint8Array>;
  push(chunk: string): void;
  close(): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  // `start` 在构造函数里同步执行，所以 controller 出了这个块就一定有值。
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(ENCODER.encode(chunk)),
    close: () => controller.close(),
  };
}

describe('translateOpenAiStreamToAnthropic', () => {
  it('把 OpenAI 流翻成 Anthropic 事件序列', async () => {
    const out = await collect(
      translateOpenAiStreamToAnthropic(
        sourceOf([
          data({ id: 'c1', model: 'gpt-4o', choices: [{ delta: { content: 'hi' } }] }),
          data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ]),
        { fallbackModel: 'gpt-4o', pingIntervalMs: 0 }
      )
    );
    expect(out).toContain('event: message_start');
    expect(out).toContain('"text_delta"');
    expect(out.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it('关掉心跳时一个 ping 都不发（正常流不该被塞进多余事件）', async () => {
    const out = await collect(
      translateOpenAiStreamToAnthropic(sourceOf([data({ id: 'c', model: 'm', choices: [] })]), {
        fallbackModel: 'm',
        pingIntervalMs: 0,
      })
    );
    expect(out).not.toContain('event: ping');
  });

  it('★ 上游长时间沉默时自己造 ping（否则 Claude Code 的字节看门狗会中断流）', async () => {
    vi.useFakeTimers();
    try {
      const source = controlledSource();
      const translated = translateOpenAiStreamToAnthropic(source.stream, {
        fallbackModel: 'm',
        pingIntervalMs: 1_000,
      });

      const chunks: string[] = [];
      const reader = translated.getReader();
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(DECODER.decode(value));
        }
      })();

      source.push(data({ id: 'c', model: 'm', choices: [{ delta: { content: 'a' } }] }));
      await vi.advanceTimersByTimeAsync(3_500);
      source.close();
      await pump;

      const pings = chunks.join('').match(/event: ping/g) ?? [];
      expect(pings.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('有输出时不补 ping（心跳是空闲触发，不是固定周期）', async () => {
    vi.useFakeTimers();
    try {
      const source = controlledSource();
      const reader = translateOpenAiStreamToAnthropic(source.stream, {
        fallbackModel: 'm',
        pingIntervalMs: 1_000,
      }).getReader();
      const chunks: string[] = [];
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(DECODER.decode(value));
        }
      })();

      for (let i = 0; i < 4; i++) {
        source.push(data({ id: 'c', model: 'm', choices: [{ delta: { content: 'x' } }] }));
        await vi.advanceTimersByTimeAsync(600);
      }
      source.close();
      await pump;
      expect(chunks.join('')).not.toContain('event: ping');
    } finally {
      vi.useRealTimers();
    }
  });

  it('客户端提前 cancel 不抛，也不再写字节', async () => {
    const stream = translateOpenAiStreamToAnthropic(
      sourceOf([
        data({ id: 'c', model: 'm', choices: [{ delta: { content: 'a' } }] }),
        data({ choices: [{ delta: { content: 'b' } }] }),
      ]),
      { fallbackModel: 'm', pingIntervalMs: 50 }
    );
    const reader = stream.getReader();
    await reader.read();
    await expect(reader.cancel('client gone')).resolves.toBeUndefined();
  });

  it('默认心跳间隔远小于 300s 看门狗', () => {
    expect(DEFAULT_PING_INTERVAL_MS).toBeLessThan(60_000);
    expect(DEFAULT_PING_INTERVAL_MS).toBeGreaterThan(0);
  });
});
