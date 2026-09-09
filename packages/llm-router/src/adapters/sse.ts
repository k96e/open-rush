/**
 * Anthropic SSE 帧的编码（M4·T4.7）。
 *
 * 只在 **translate** 模式下用到——同协议路径上一个字节都不重新编码（A1 第一档）。
 *
 * 帧格式按 Anthropic Messages 流式规范：`event:` 行 + `data:` 行 + 空行。
 * `event:` 行不是可选的：Anthropic 的官方 SDK 按事件名分发，只发 `data:` 的流
 * 在部分客户端上会被当成未知事件丢弃。
 */

/** 一条 SSE 事件。`data` 会被 `JSON.stringify`，因此不得含未定义的循环引用。 */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 保活心跳。
 *
 * Claude Code 在 `ANTHROPIC_BASE_URL` 连接上有 **300 秒字节级看门狗**：
 * 只要流静默超过这个时间就会中断。真 Anthropic 上游在长思考期间靠 `ping` 撑着，
 * 而 **OpenAI 兼容上游一个 ping 都不发**——所以翻译出来的流必须自己造。
 * 这是官方 gateway 文档对「从不发 ping 的上游翻译过来」的明确要求。
 */
export function pingEvent(): string {
  return sseEvent('ping', { type: 'ping' });
}
