import { describe, expect, it } from 'vitest';
import { AnthropicSseUsageParser } from '../anthropic-parser.js';

const ENCODER = new TextEncoder();

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1200,"cache_creation_input_tokens":500,"cache_read_input_tokens":9000,"output_tokens":1}}}',
  '',
  ': ping',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好，世界 🌏"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":345}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

/** 按固定步长切块——步长 1 时几乎每个多字节字符都会被切开。 */
function feed(parser: AnthropicSseUsageParser, text: string, step: number): void {
  const bytes = ENCODER.encode(text);
  for (let i = 0; i < bytes.length; i += step) {
    parser.push(bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
}

describe('AnthropicSseUsageParser', () => {
  it.each([1, 3, 7, 64, 4096])('步长 %i 的分块下解析结果一致', (step) => {
    const parser = new AnthropicSseUsageParser();
    feed(parser, SSE, step);
    expect(parser.result()).toEqual({
      tokensIn: 1200,
      tokensCacheWrite: 500,
      tokensCacheRead: 9000,
      tokensOut: 345,
      tokensReasoning: 0,
      upstreamModel: 'claude-sonnet-4-6',
      stopReason: 'end_turn',
    });
  });

  it('message_delta 是累计值：多个 delta 取 max 而不是相加', () => {
    const parser = new AnthropicSseUsageParser();
    feed(
      parser,
      [
        'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":10,"output_tokens":1}}}',
        'data: {"type":"message_delta","usage":{"output_tokens":50}}',
        'data: {"type":"message_delta","usage":{"output_tokens":120}}',
        '',
      ].join('\n'),
      4096
    );
    expect(parser.result().tokensOut).toBe(120);
  });

  it('乱序/回退的 delta 不会把计数改小', () => {
    const parser = new AnthropicSseUsageParser();
    feed(
      parser,
      [
        'data: {"type":"message_delta","usage":{"output_tokens":120}}',
        'data: {"type":"message_delta","usage":{"output_tokens":50}}',
        '',
      ].join('\n'),
      4096
    );
    expect(parser.result().tokensOut).toBe(120);
  });

  it('只有 message_start 没有 message_delta 时也能出数', () => {
    const parser = new AnthropicSseUsageParser();
    feed(
      parser,
      'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":7,"output_tokens":2}}}\n',
      4096
    );
    expect(parser.result()).toMatchObject({ tokensIn: 7, tokensOut: 2, upstreamModel: 'm' });
  });

  it('畸形 JSON / 注释行 / event 行 / 空 data 都被跳过而不抛错', () => {
    const parser = new AnthropicSseUsageParser();
    expect(() =>
      feed(
        parser,
        [
          ': 这是注释',
          'event: message_start',
          'id: 42',
          'data: {不是合法 JSON',
          'data: [1,2,3]',
          'data:',
          'data: [DONE]',
          'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":5}}}',
          '',
        ].join('\n'),
        4096
      )
    ).not.toThrow();
    expect(parser.result().tokensIn).toBe(5);
  });

  it('CRLF 行结尾同样能解析', () => {
    const parser = new AnthropicSseUsageParser();
    feed(
      parser,
      'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":9}}}\r\n\r\n',
      4096
    );
    expect(parser.result().tokensIn).toBe(9);
  });

  it('非流式 body：从整份 JSON 取 usage / model / stop_reason', () => {
    const parser = new AnthropicSseUsageParser();
    parser.pushNonStreamBody(
      ENCODER.encode(
        JSON.stringify({
          model: 'claude-opus-4-6',
          stop_reason: 'max_tokens',
          usage: {
            input_tokens: 11,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          },
        })
      )
    );
    expect(parser.result()).toEqual({
      tokensIn: 11,
      tokensCacheWrite: 2,
      tokensCacheRead: 3,
      tokensOut: 4,
      tokensReasoning: 0,
      upstreamModel: 'claude-opus-4-6',
      stopReason: 'max_tokens',
    });
  });

  it('非流式 body 非法 JSON → 全零且不抛', () => {
    const parser = new AnthropicSseUsageParser();
    expect(() => parser.pushNonStreamBody(ENCODER.encode('<html>502</html>'))).not.toThrow();
    expect(parser.result()).toEqual({
      tokensIn: 0,
      tokensCacheWrite: 0,
      tokensCacheRead: 0,
      tokensOut: 0,
      tokensReasoning: 0,
      upstreamModel: null,
      stopReason: null,
    });
  });
});
