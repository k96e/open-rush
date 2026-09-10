import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['llm-router/__tests__/**/*.test.ts'],
    // 假上游 / 假 agent-worker 都要真起 HTTP 监听，串行跑避免端口与 CPU 争抢。
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
