/**
 * 往返测试（M4·T4.7 的验收标准）：Anthropic 请求 → OpenAI 请求 → OpenAI 响应
 * → Anthropic 响应，断言**语义等价**。
 *
 * ⚠️ 这一档**明确不承诺字节一致**（A1 第三档）。所以下面断言的全是语义：
 * 文本原样、工具名与参数原样、stop_reason 映射正确、用量口径一致；
 * 而不是任何形式的字节比较。
 *
 * 「假模型」只做一件事：把翻译过去的 OpenAI 请求原样回读成一份 OpenAI 响应。
 * 这样往返里唯一的变量就是两个方向的映射本身。
 */
import { describe, expect, it } from 'vitest';
import { translateAnthropicRequest } from '../anthropic-to-openai.js';
import {
  OpenAiToAnthropicStreamTranslator,
  translateOpenAiCompletion,
} from '../openai-to-anthropic.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

type Obj = Record<string, unknown>;

function toOpenAi(req: Obj, stream = false): Obj {
  return JSON.parse(
    DECODER.decode(
      translateAnthropicRequest(ENCODER.encode(JSON.stringify(req)), {
        upstreamModel: 'gpt-4o',
        stream,
      })
    )
  ) as Obj;
}

function backToAnthropic(res: Obj): Obj {
  const out = translateOpenAiCompletion(ENCODER.encode(JSON.stringify(res)), 'gpt-4o');
  if (!out) throw new Error('untranslatable');
  return JSON.parse(DECODER.decode(out)) as Obj;
}

/** 把翻译后的 OpenAI 请求当成「模型的输入」，回一份带同样内容的 OpenAI 响应。 */
function echoCompletion(openaiReq: Obj, over: Obj = {}): Obj {
  const messages = openaiReq.messages as Obj[];
  const last = messages.at(-1) ?? {};
  return {
    id: 'chatcmpl-echo',
    object: 'chat.completion',
    model: openaiReq.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: String(last.content ?? '') },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
    ...over,
  };
}

describe('往返 · 文本', () => {
  it('用户文本一路走到底不变形', () => {
    const anthropicReq: Obj = {
      model: 'my-alias',
      max_tokens: 512,
      system: 'you are terse',
      messages: [{ role: 'user', content: '你好，世界' }],
    };
    const openaiReq = toOpenAi(anthropicReq);
    expect(openaiReq.messages).toEqual([
      { role: 'system', content: 'you are terse' },
      { role: 'user', content: '你好，世界' },
    ]);

    const back = backToAnthropic(echoCompletion(openaiReq));
    expect(back).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'gpt-4o',
      content: [{ type: 'text', text: '你好，世界' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    });
    expect(back.usage).toEqual({
      input_tokens: 11,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
    });
  });
});

describe('往返 · 工具调用', () => {
  const anthropicReq: Obj = {
    model: 'my-alias',
    max_tokens: 512,
    tools: [
      {
        name: 'get_weather',
        description: 'look up weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: 'weather in SF?' }],
  };

  it('工具定义与 tool_choice 一起翻过去', () => {
    const openaiReq = toOpenAi(anthropicReq);
    expect(openaiReq.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          description: 'look up weather',
        },
      },
    ]);
    expect(openaiReq.tool_choice).toBe('required');
  });

  it('★ 模型的 tool_calls 翻回 tool_use，工具名与参数逐字保留', () => {
    const openaiReq = toOpenAi(anthropicReq);
    const back = backToAnthropic(
      echoCompletion(openaiReq, {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"San Francisco"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    expect(back.content).toEqual([
      { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'San Francisco' } },
    ]);
    expect(back.stop_reason).toBe('tool_use');
  });

  it('★ 下一轮：assistant 的 tool_use + user 的 tool_result 翻成 OpenAI 的合法顺序', () => {
    const openaiReq = toOpenAi({
      ...anthropicReq,
      messages: [
        { role: 'user', content: 'weather in SF?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'SF' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: '18°C, sunny' }],
        },
      ],
    });
    expect(openaiReq.messages).toEqual([
      { role: 'user', content: 'weather in SF?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: '18°C, sunny' },
    ]);
  });
});

describe('往返 · stop_reason 五条映射', () => {
  const cases: [string, string][] = [
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['content_filter', 'refusal'],
  ];
  for (const [finish, expected] of cases) {
    it(`${finish} → ${expected}`, () => {
      const back = backToAnthropic({
        id: 'c',
        model: 'gpt-4o',
        choices: [{ message: { content: 'x' }, finish_reason: finish }],
      });
      expect(back.stop_reason).toBe(expected);
    });
  }
});

describe('往返 · 流式与非流式给出同一份语义', () => {
  it('同样的内容，流式拼出来的文本与非流式一致，stop_reason / usage 也一致', () => {
    const nonStream = backToAnthropic({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 2 },
    });

    const t = new OpenAiToAnthropicStreamTranslator({ fallbackModel: 'gpt-4o' });
    let sse = '';
    for (const chunk of [
      { id: 'chatcmpl-1', model: 'gpt-4o', choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
    ]) {
      sse += t.push(ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }
    sse += t.end();

    const events = sse
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.split('\n')[1].slice(6)) as Obj);

    const text = events
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => (e.delta as Obj).text)
      .join('');
    const messageDelta = events.find((e) => e.type === 'message_delta');

    expect(text).toBe((nonStream.content as Obj[])[0].text);
    expect((messageDelta?.delta as Obj).stop_reason).toBe(nonStream.stop_reason);
    expect(messageDelta?.usage).toEqual(nonStream.usage);
  });
});
