import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    /**
     * 这个包里的测试会**真的 spawn 子进程**（`audit-no-plaintext-key.sh` 是 shell
     * 脚本，只能这么测）。子进程的耗时取决于机器负载与 I/O，不取决于被测逻辑：
     * 同一套用例在开发机上 716 ms 跑完，在 CI 上因为与 web / control-plane / db
     * 三个测试任务并行抢 4 核，慢到 22.7 s，默认的 5 s 超时于是把 CI 打红了。
     *
     * 所以这里给的是**余量**而不是「允许慢」——真的挂了会在 30 s 内报出来，
     * 而机器抖动不会再变成一次假失败。同理见 `e2e/vitest.config.ts`。
     */
    testTimeout: 30_000,
  },
});
