import { describe, expect, it } from 'vitest';
import { OpenAiSseUsageParser } from '../openai-parser.js';

const ENCODER = new TextEncoder();

function feed(parser: OpenAiSseUsageParser, text: string, step = 4096): void {
  const bytes = ENCODER.encode(text);
  for (let i = 0; i < bytes.length; i += step) {
    parser.push(bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
}

const STREAM = [
  'data: {"id":"c1","model":"gpt-x","choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
  '',
  'data: {"id":"c1","model":"gpt-x","choices":[{"delta":{"content":" 世界 🌏"},"finish_reason":"stop"}]}',
  '',
  'data: {"id":"c1","model":"gpt-x","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":300,"total_tokens":1300,"prompt_tokens_details":{"cached_tokens":400},"completion_tokens_details":{"reasoning_tokens":120}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('OpenAiSseUsageParser', () => {
  it.each([1, 5, 64, 4096])('步长 %i 下从末个 choices:[] chunk 解析 usage', (step) => {
    const parser = new OpenAiSseUsageParser();
    feed(parser, STREAM, step);
    expect(parser.result()).toEqual({
      // prompt_tokens 含缓存命中，减掉后才是非缓存输入
      tokensIn: 600,
      tokensCacheWrite: 0,
      tokensCacheRead: 400,
      tokensOut: 300,
      tokensReasoning: 120,
      upstreamModel: 'gpt-x',
      stopReason: 'stop',
    });
  });

  it('没有 prompt_tokens_details 时 cache_read 为 0、tokensIn 不减', () => {
    const parser = new OpenAiSseUsageParser();
    feed(parser, 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n');
    expect(parser.result()).toMatchObject({ tokensIn: 10, tokensCacheRead: 0, tokensOut: 2 });
  });

  it('cached_tokens 大于 prompt_tokens 时 tokensIn 收敛到 0 而不是负数', () => {
    const parser = new OpenAiSseUsageParser();
    feed(
      parser,
      'data: {"choices":[],"usage":{"prompt_tokens":5,"prompt_tokens_details":{"cached_tokens":9}}}\n'
    );
    expect(parser.result().tokensIn).toBe(0);
  });

  it('流式未开 include_usage（没有 usage chunk）时全零但不抛', () => {
    const parser = new OpenAiSseUsageParser();
    expect(() =>
      feed(parser, 'data: {"model":"gpt-x","choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n')
    ).not.toThrow();
    expect(parser.result()).toMatchObject({ tokensIn: 0, tokensOut: 0, upstreamModel: 'gpt-x' });
  });

  it('畸形 JSON 被跳过', () => {
    const parser = new OpenAiSseUsageParser();
    feed(parser, 'data: {oops\ndata: {"choices":[],"usage":{"completion_tokens":8}}\n');
    expect(parser.result().tokensOut).toBe(8);
  });

  it('非流式 body：直接解析整份 JSON', () => {
    const parser = new OpenAiSseUsageParser();
    parser.pushNonStreamBody(
      ENCODER.encode(
        JSON.stringify({
          model: 'gpt-y',
          choices: [{ finish_reason: 'length' }],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 9,
            prompt_tokens_details: { cached_tokens: 10 },
            completion_tokens_details: { reasoning_tokens: 4 },
          },
        })
      )
    );
    expect(parser.result()).toEqual({
      tokensIn: 20,
      tokensCacheWrite: 0,
      tokensCacheRead: 10,
      tokensOut: 9,
      tokensReasoning: 4,
      upstreamModel: 'gpt-y',
      stopReason: 'length',
    });
  });
});
