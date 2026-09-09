/**
 * A1 的核心测试：随机分块下的字节级透传 + chunk 对象引用一致 + 旁路隔离。
 */
import { describe, expect, it, vi } from 'vitest';
import { teeForMetering } from '../sse-tee.js';

const ENCODER = new TextEncoder();

/** 一段真实形状的 Anthropic SSE：含 event 行、ping、注释行、多字节字符。 */
const SSE_FIXTURE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1200,"cache_creation_input_tokens":500,"cache_read_input_tokens":9000,"output_tokens":1}}}',
  '',
  ': ping heartbeat',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好，世界 🌏"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":345}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** 把字节按随机边界切成 n 段（可能切在多字节字符中间——这正是要覆盖的情形）。 */
function splitRandomly(bytes: Uint8Array, n: number, seed: number): Uint8Array[] {
  const cuts = new Set<number>();
  let s = seed;
  while (cuts.size < n - 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const at = 1 + (s % Math.max(1, bytes.length - 1));
    cuts.add(at);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const cut of sorted) {
    out.push(bytes.subarray(prev, cut));
    prev = cut;
  }
  out.push(bytes.subarray(prev));
  return out;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const seen: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen.push(value);
  }
  return seen;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

describe('teeForMetering', () => {
  const source = ENCODER.encode(SSE_FIXTURE);

  it.each([2, 3, 5, 9, 17])('%i 组随机分块下逐字节一致且分块不变', async (n) => {
    const chunks = splitRandomly(source, n, n * 7919);
    const observed: Uint8Array[] = [];
    const teed = teeForMetering(streamOf(chunks), {
      onChunk: (c) => observed.push(c),
      onEnd: () => {},
    });

    const downstream = await drain(teed);

    expect(concat(downstream)).toEqual(source);
    expect(downstream).toHaveLength(chunks.length);
    // ★ 同一个对象引用：没有拷贝、没有重新分块
    for (let i = 0; i < chunks.length; i++) {
      expect(downstream[i]).toBe(chunks[i]);
      expect(observed[i]).toBe(chunks[i]);
    }
  });

  it('正常读完调用一次 onEnd，且不带 reason', async () => {
    const onEnd = vi.fn();
    await drain(teeForMetering(streamOf([source]), { onChunk: () => {}, onEnd }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(undefined);
  });

  it('客户端提前 cancel → onEnd 带 reason 且只调用一次', async () => {
    const onEnd = vi.fn();
    const chunks = splitRandomly(source, 4, 31);
    const teed = teeForMetering(streamOf(chunks), { onChunk: () => {}, onEnd });
    const reader = teed.getReader();
    await reader.read();
    await reader.cancel('client gone');

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0][0]).toBe('client gone');
  });

  it('onChunk 抛错时流仍然完整（旁路隔离）', async () => {
    const chunks = splitRandomly(source, 6, 991);
    const onEnd = vi.fn();
    const teed = teeForMetering(streamOf(chunks), {
      onChunk: () => {
        throw new Error('parser blew up');
      },
      onEnd,
    });

    const downstream = await drain(teed);
    expect(concat(downstream)).toEqual(source);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('onEnd 抛错不会污染主链路', async () => {
    const teed = teeForMetering(streamOf([source]), {
      onChunk: () => {},
      onEnd: () => {
        throw new Error('recorder blew up');
      },
    });
    await expect(drain(teed)).resolves.toHaveLength(1);
  });

  it('空流也会调用一次 onEnd', async () => {
    const onEnd = vi.fn();
    await drain(teeForMetering(streamOf([]), { onChunk: () => {}, onEnd }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
