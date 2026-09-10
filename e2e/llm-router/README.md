# llm-router 验收套件（M7·T7.1）

对照 [`docs/plans/llm-router/ref/R6-验收自证.md`](../../docs/plans/llm-router/ref/R6-验收自证.md) 的 A1–A11 逐项自证。
结论与取舍写在 [`docs/llm-router-acceptance.md`](../../docs/llm-router-acceptance.md)，
逐条实测数据落在 `docs/llm-router-acceptance.results.json`（由本套件生成）。

## 三条设计约束

1. **一律打本地假上游，不打真供应商。**
   「请求体逐字节一致」只有在上游肯把收到的原始字节交出来时才可判定；
   「响应体逐字节一致」在真供应商上根本无从比对——每次生成都不同。
   可复现性优先于「像真的」。
2. **网关跑在独立子进程里**（`node apps/llm-router/dist/server.js`），
   不 import `createApp()` 在测试进程内跑。A3（摘流）、A9（日志）、A11（堆快照）
   的证据都长在进程边界上，同进程跑等于把要证明的东西提前假设掉。
3. **判定分 `pass` / `partial` / `fail` 三档。** 本机环境证不到的那一半标 `partial`
   并写清原因，不含糊成 `pass`。退出码只看 `fail`：有 `fail` 才返回 1。

## 前置

```bash
pnpm install
pnpm db:up                                   # PostgreSQL 16 (pgvector) + Redis
pnpm --filter @open-rush/db db:migrate       # 应用到 0012_llm_router
pnpm build                                   # 套件跑的是 apps/llm-router 的**构建产物**
```

> 没有 Docker 时也可以用宿主机上的 PostgreSQL 16 + Redis 7：建库 `rush`、
> 建角色 `rush/rush`，装上 `pgvector`（`postgresql-16-pgvector`），
> 再跑同一条 `db:migrate`。套件只要一个能连的 `DATABASE_URL`。

## 跑

```bash
DATABASE_URL=postgresql://rush:rush@localhost:5432/rush \
REDIS_URL=redis://127.0.0.1:6379 \
pnpm --filter @open-rush/e2e llm:acceptance
```

大约 1 分钟。全程会起 8 个 llm-router 子进程（端口 18790–18797）、一个假上游、
一个假 agent-worker，跑完自动清场（种子数据一律带 `acc-` 前缀，
被 Ctrl-C 打断后下一次启动会自动清理残留）。

### 可调开关

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `ACC_BENCH_N` | `200` | A2 每个并发档位的采样次数 |
| `ACC_BENCH_CONCURRENCY` | `1,8,32` | A2 的并发档位 |
| `ACC_RUN_TAIL_MS` | `2000` | A5 里假 agent-worker 在最后一次网关调用之后的停顿，用于让网关的异步批写落库 |
| `ACC_DB_STOP_CMD` / `ACC_DB_START_CMD` | 未设置 | A5 的「停掉 DB 调用仍成功」实测。**成对设置才生效**，否则该子项记 `partial` |

停 DB 那一项的两种典型写法：

```bash
# Docker Compose
ACC_DB_STOP_CMD='docker compose -f docker/docker-compose.dev.yml stop postgres'
ACC_DB_START_CMD='docker compose -f docker/docker-compose.dev.yml start postgres'

# 宿主机 PostgreSQL（Debian/Ubuntu）
ACC_DB_STOP_CMD='pg_ctlcluster 16 main stop'
ACC_DB_START_CMD='pg_ctlcluster 16 main start'
```

> ⚠️ 这一项**真的会把数据库停掉**。重启动作在 `finally` 里，但如果进程在 stop 与 start
> 之间被 Ctrl-C / OOM 杀掉，数据库会一直停着——后面任何依赖它的命令（`pnpm test:integration`
> 首当其冲）都会报 `ECONNREFUSED 127.0.0.1:5432`。手动起回来即可：`ACC_DB_START_CMD` 那条命令。

## 单独跑假上游

```bash
FAKE_UPSTREAM_PORT=9999 pnpm --filter @open-rush/e2e llm:fake-upstream
```

`?behavior=hang|reset|error429|error500` 注入故障，`?delayMs=<n>` 拉长流。
`GET /__control/requests` 取回捕获的请求（含原始 body 的 base64 与 sha256），
`GET /__control/reset` 清空。

## 单独跑性能基线（T7.2）

```bash
npx tsx scripts/bench-llm-router.ts \
  --gateway http://127.0.0.1:8790 --upstream http://127.0.0.1:9999 \
  --token rt_xxx --model acc-passthrough --n 500 --concurrency 1,8,32
```

加 `--json` 输出机器可读结果（验收套件就是这么调它的）。

## 单独跑泄漏审计（T7.3）

```bash
DATABASE_URL=... AUDIT_LOG_DIR=/tmp/logs \
  scripts/audit-no-plaintext-key.sh 'sk-ant-REAL-KEY-...'
```

退出码 0 = 执行到的探针全 clean，1 = 至少一处命中，2 = 用法错误。
**跳过的探针会单独列出来，不算通过。**

## 目录结构

```
e2e/llm-router/
├── acceptance.ts            # A1–A11 主驱动
├── fake-upstream.ts         # 本地假上游（回放 + 故障注入 + 请求捕获）
├── fixtures/                # 请求与 SSE 的固定装置（逐字节比对的基准）
├── lib/
│   ├── seed.ts              # 目录 / 凭据 / 令牌 的数据种子与清场
│   ├── router-process.ts    # 起停 llm-router 子进程 + 端口占用自检
│   ├── fake-agent-worker.ts # 替掉 Claude Code CLI 的那一段，其余全是真的
│   ├── heap-probe-peer.ts   # A11 堆快照对照组（没有私钥的进程）
│   ├── compare.ts           # 字节 / 结构 / SSE 序列比对（纯函数）
│   ├── probe.ts             # 明文泄漏探针（纯函数）
│   └── report.ts            # 判定收集与渲染（纯函数）
└── __tests__/               # 上述纯函数与两个假服务的单测（pnpm --filter @open-rush/e2e test）
```
