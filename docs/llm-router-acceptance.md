# llm-router 验收自证（A1–A11）

> **生成方式**：`pnpm --filter @open-rush/e2e llm:acceptance`（复现步骤见 [`e2e/llm-router/README.md`](../e2e/llm-router/README.md)）
> **逐条实测数据**：`docs/llm-router-acceptance.results.json`（由上面那条命令写出，本文所有数字都引自它）
> **验收口径出处**：[`docs/plans/llm-router/ref/R6-验收自证.md`](./plans/llm-router/ref/R6-验收自证.md)

**本文写的是论证，不是绿灯。** 每一项都按 R6 的要求给四段：**判定口径 → 验证方法 → 命令/测试 → 已知取舍**。
取舍一栏不许空着——软限额、Anthropic 推理 token 不可拆、吊销生效 ≤15 s、堆快照对照实验的结论与预期不同，
这些如实写出来比藏起来有说服力。

---

## 0. 本次运行的环境与判定规则

| 项 | 值 |
| --- | --- |
| 运行时间 | 见 `results.json` 的 `generatedAt` |
| 耗时 | 55 s |
| 机器 | 4 vCPU 容器；PostgreSQL 16 + pgvector、Redis 7 跑在同一台 |
| 上游 | **本地假上游**（`e2e/llm-router/fake-upstream.ts`），不打真供应商 |
| 网关 | `node apps/llm-router/dist/server.js`，**独立子进程**（一次运行会起 8 个副本，端口 18790–18797） |
| 结果 | **pass 8 · partial 3 · fail 0** |

判定分三档，`partial` 是一等公民：

- `pass` — 本机实测到位，全部断言成立。
- `partial` — 机制已落且有单测钉死，但**本机环境证不到那一半**；原因逐条写在下面，不含糊成 pass。
- `fail` — 有断言不成立。本次为 0。

退出码只看 `fail`。

### 为什么一律打假上游

两条理由缺一不可：

1. **「请求体逐字节一致」只有在上游肯把收到的原始字节交出来时才可判定。** 真供应商不会。
2. **「响应体逐字节一致」在真供应商上根本无从比对**——同一个 prompt 每次生成都不同。

代价写在 A1/A11 的取舍里：真供应商的行为（强制 gzip、私有 beta 语义、限流策略）本套件证不了，
那属于 [`ref/R7`](./plans/llm-router/ref/R7-风险与上线.md) §10.2 阶段 1「影子回放」的范围。

---

## A1 · 请求/响应透传语义（body 零改写 + SSE 不丢不改序） — ✅

**判定口径**（按承诺分层，三档各有各的承诺）

| 档 | 触发条件 | 承诺 |
| --- | --- | --- |
| `passthrough` | `alias == upstreamModel` | 请求体上下游**逐字节**一致；响应体**逐字节**一致 |
| `rewrite-model` | 异名 | 除 `$.model` 外解析后**深度相等** |
| `translate` | 跨协议（Anthropic 面 → OpenAI 上游） | **不承诺字节一致**，只承诺语义等价 |

**验证方法**

假上游把每次收到的请求原始字节存下来；驱动侧把 fixture 的原始字节直接 `--data-binary` 发出去，
再把收到的响应字节与 fixture 的 SSE 逐字节比。`rewrite-model` 用「忽略顶层 `model` 后的稳定序列化」比对，
避免把 JSON 重建导致的键序变化误判成语义变化。

**命令 / 实测**

```
pnpm --filter @open-rush/e2e llm:acceptance   # A1
```

- 上游收到的请求体与调用方发出的**逐字节相同**（363 B，首个差异下标 `-1`）
- 响应体与上游 fixture **逐字节相同**（977 B）
- `?beta=true` 原样带到上游（上游看到的 URL 是 `/v1/messages?beta=true`）
- 一个**从未见过的** `anthropic-beta: totally-new-capability-2099-01-01` 原样到达上游
  → 证明走的是**开放列表**而不是白名单
- 上游收到的 `Authorization` 是解封后的供应商真 key，不是调用方的 router 令牌
- `rewrite-model`：`deepEqualExcept(before, after, ['model'])` 成立；`$.model` 被改成 `fake-anthropic-upstream`
- `translate`：上游收到的是 `/v1/chat/completions` + OpenAI 形状 body（`system` 被摊平成 system message），
  回给调用方的仍是 Anthropic 形状的事件序列
- 分块层面另由 `packages/llm-router` 的 `sse-tee.test.ts` 钉死：2/3/5/9/17 组随机分块下拼接字节一致、
  chunk 数量相同、**每个 chunk 与上游是同一个对象引用**

**已知取舍**

1. 向上游发 `accept-encoding: identity`。上游若**强制**返回 gzip，下游拿到的仍是同样的字节（字节一致仍成立），
   但 usage 旁路解析会失败并记 `tokens=0`，该次调用降级为只进 run 级聚合。本地假上游不压缩，这一路没实测。
2. `translate` 档**只交付 Anthropic-in → OpenAI-out 一个方向**；反方向与 `/v1/messages/count_tokens` 仍回 404。
   10 条有损项逐条列在 [`ref/R9-协议翻译调研.md`](./plans/llm-router/ref/R9-协议翻译调研.md) §9.6
   （`message_start.usage` 全 0、`stop_sequence` 恒 null、工具参数不逐字流出、thinking 不还原等）。

---

## A2 · 转发性能（p95 附加延迟，TTFB 与总耗时分开报） — 🟡

**判定口径**：`p95(经网关) − p95(直连假上游)`，同一 fixture、同一并发。
**目标 < 15 ms 按并发 1 判定**——那才是「网关本身要多花多少」。并发档位测的是另一件事：单副本的饱和曲线。

**验证方法**：`scripts/bench-llm-router.ts` 对同一个 fixture 跑两条腿（直连 / 经网关），
每条腿先预热 20 次再采样 N 次；TTFB 取**第一个 body 分块**到达的时刻（对 SSE 才有意义），
总耗时取整条流读完的时刻。

**命令 / 实测**（n=200，4 vCPU，load1=0.42）

| 并发 | 直连 TTFB p95 | 网关 TTFB p95 | **ΔTTFB p95** | 直连总耗时 p95 | 网关总耗时 p95 | **Δ总耗时 p95** | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.24 ms | 4.01 ms | **2.77 ms** | 1.29 ms | 4.59 ms | **3.30 ms** | 0 |
| 8 | 7.34 ms | 32.17 ms | **24.83 ms** | 7.35 ms | 32.24 ms | **24.89 ms** | 0 |
| 32 | 27.20 ms | 144.84 ms | **117.65 ms** | 27.21 ms | 144.88 ms | **117.66 ms** | 0 |

- ✅ 并发 1 的 ΔTTFB p95 = **2.77 ms** < 15 ms
- 🟡 并发 8 / 32 超过 15 ms（最差 117.65 ms）。**三次运行的并发 32 落在 118–207 ms 之间**——这个抖动本身就说明该档位测的是机器不是网关

**ΔTTFB 与 Δ总耗时几乎相等**，这正是网关的设计意图在数字上的样子：转发路径上没有缓冲，
首字节一到就往下游写，计量走的是旁路（先 enqueue 后 observe）。

**已知取舍**

1. **并发档位的数字不是「网关的开销」。** 本机 4 核上，网关腿有客户端 / 网关 / 假上游三个 Node 进程抢 CPU，
   直连腿只有两个——高并发下比的已经是「多一个进程要多抢多少 CPU」。要得到真实的单副本饱和点，
   必须在目标机型上、把三方分开部署再压。结论按 D11 处理：**网关无状态，横向扩副本**。
2. 本机、无 TLS、假上游，不含跨主机网络与 TLS 握手。
3. **非流式**请求会在网关侧完整缓冲 body（为了解析 usage），大响应多一次内存拷贝；
   Claude Code 走的是流式路径，无此开销。本表测的是流式。

---

## A3 · 可用性（滚动更新不中断） — ✅

**判定口径**：摘流期间**已建立的流全部正常收尾**，新请求全部落到健康副本，**零 5xx**。

**验证方法**：起两个副本 + 一个极简 LB（每次发请求前查一次 `/readyz`，503 的副本立刻摘掉——
这就是 K8s readiness probe 的语义，只是周期缩到了每请求）。持续打流式请求的同时，
对其中一个副本发 `SIGTERM`；被 kill 的副本上另有一条**跨越 SIGTERM** 的在途流
（上游每 60 B 停 90 ms，整条约 1.5 s）。

**命令 / 实测**

- SIGTERM 后 `/readyz` **立刻**返回 503（不等 drain 结束）
- 摘流期间的在途流正常收尾，**字节与 fixture 完全一致**（没有被截断）
- 全程 **504 次**请求，**5xx = 0**，连接失败 = 0
- 被摘流的副本在 drain 窗口（本次配 3 s）后 `exit 0` 干净退出

**已知取舍**

1. 单个流的最长时长可能**超过** drain 窗口（默认 30 s），超时后会被强制断开。
   缓解：把 `DRAIN_TIMEOUT_MS` 配成大于典型 run 的单次调用时长，K8s 侧同步放大 `terminationGracePeriodSeconds`。
2. 本项的 LB 比真实 ingress **更严格**——真实探针有 `periodSeconds` 的滞后，会多丢几个请求到正在排空的副本上，
   而那正是 drain 窗口存在的理由。真实 ingress 下的 5xx 计数还取决于 `proxy_buffering` 等配置（见 R7 的 R4）。

---

## A4 · 路由准确率（100% / 未知 404） — ✅

**判定口径**：每个 alias 落到**唯一确定**的 (provider, upstreamModel)；未知与 disabled 一律 404，
且错误体**不枚举**目录里的其它模型名。

**验证方法**：造 12 条目录记录，覆盖 passthrough / 异名 / 跨协议 / **并列 priority** / 同名 alias 跨 provider /
disabled / 只有 disabled 候选 / 指向死端口，逐条发请求并断言假上游收到的 path + `$.model`。

**命令 / 实测**

| alias | 期望 | 实测 |
| --- | --- | --- |
| `acc-passthrough` | 200 · `/v1/messages` · `acc-passthrough` | ✅ |
| `acc-rewrite` | 200 · `/v1/messages` · `fake-anthropic-upstream` | ✅ |
| `acc-openai` | 200 · `/v1/chat/completions`（translate） | ✅ |
| `acc-openai-rewrite` | 200 · `/v1/chat/completions` · `fake-openai-upstream` | ✅ |
| `acc-tied`（并列 priority） | 200 · 确定性地选中同一条 | ✅ |
| `acc-priority`（priority 有高下） | 200 · `winner`（priority 小者胜出） | ✅ |
| `acc-disabled` / `acc-disabled-only` | 404 | ✅ |
| `acc-nope-1` / `acc-nope-2` / `acc-ghost` | 404 | ✅ |

另外两条：

- 404 错误体**回显被请求的 alias**，且不含 `acc-passthrough` / `acc-rewrite` / `acc-openai` / `acc-disabled`
  中的任何一个 → 不构成枚举泄露
- **令牌白名单先于路由**：受限令牌请求 `acc-not-allowed` 回 **403** 而不是 404
  （令牌不允许的模型，连它存不存在都不该泄露）

**已知取舍**：并列 priority 的胜者由 `(priority, id)` 决定，`id` 是 uuid ——
对运维而言等价于「**不要靠并列 priority 表达偏好**」。本项断言的是**确定性**（同一目录下每次选同一条），
不是「选中某一个特定 provider」。

---

## A5 · 明细计量（逐调用 + subject + 与 run 级对账） — ✅

**判定口径**

- `llm_calls` 行数 == 该 run 的**实际上游调用次数**（以假上游侧计数为准）
- 每行的归属列（`run_id` / `project_id` / `agent_id` / `owner_user_id`）**全部来自令牌**，不来自请求头
- `SUM(llm_calls)` 与 run 级 `data-openrush-usage` 对得上

**验证方法**：跑一条**真**的 Run。`RunOrchestrator` 真地签发 per-run 令牌、真地注入沙箱 env、
真地消费 SSE①、真地在 `finally` 里吊销；只有 Claude Code CLI 那一段被换成假 agent-worker——
它拿注进来的 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 打网关 3 次，并**故意伪造**
`x-claude-code-session-id`。

**命令 / 实测**（`OPENRUSH_V1_EVENTS_ENABLED=true`，见取舍②）

- `llm_calls` **3 行** == 假上游侧计数 **3**；三条都是 `success / 200`
- 归属列全部来自令牌：`run_id` 等于编排器创建的那个 run
- 伪造的 `x-claude-code-session-id: forged-…-not-a-run-id` **只进 `cc_session_id`**，`run_id` 不受影响 → D6 成立
- 五类 token 逐项落库：`tokens_in=1200`、`cache_write=300`、`cache_read=900`、`tokens_out=42`、`reasoning=0`
- 定点十进制计价：单次 `1.749000 USD`
- run 级聚合 = `SUM(tokens_in + cache_write + cache_read) = 7200`、`SUM(tokens_out) = 126`、`SUM(cost_usd) = 5.247`
- `run_events` 里**恰好一条** `data-openrush-usage`，载荷与上面三个数完全一致
- run 收敛后 `llm_router_tokens.revoked_at` 已写入（A9 复核）
- **计量失败不阻塞**：`pg_ctlcluster 16 main stop` 之后再发一次调用，**仍然 200**

**已知取舍**

1. **Anthropic 族的推理 token 在协议层面不可拆。** thinking token 已计入 `output_tokens`，
   wire 上没有独立字段，因此 `tokens_reasoning` 对 Anthropic 上游**恒为 0**。
   我们能拆的是 cache read / cache write / output 三项。OpenAI 族可从
   `completion_tokens_details.reasoning_tokens` 拆出（fixture 里带了这个字段，走 OpenAI 上游时会出数）。
2. run 级 `data-openrush-usage` 受 `OPENRUSH_V1_EVENTS_ENABLED` 控制且**默认关闭**
   （`isV1EventsEnabled` 只接受字面量 `"true"`）。关闭时 `llm_calls` 照常写入——**逐调用计量不依赖这个 flag**。
3. ⚠️ **run 级聚合与网关的异步批写之间存在竞态。** `RunOrchestrator` 一消费完 SSE① 就去聚合 `llm_calls`，
   而网关的计量默认 1 s 一批（`LLM_ROUTER_METERING_FLUSH_MS`）。本套件用假 agent-worker 的 `tailDelayMs`
   显式留出这段时间（默认 2 s）；不留的话本项会实测到 `data-openrush-usage` **缺失**。
   真实部署里这段窗口由 run 的收尾工作天然填上，但**不保证**——已登记为后续项，见
   [`docs/plans/llm-router/01-进度.md`](./plans/llm-router/01-进度.md) 的「M7 发现的后续项」。
4. `run_id/project_id` 来自令牌这一条，本项证的是「伪造 header 不影响归属」；
   「令牌本身被伪造」由 SHA-256 哈希比对 + `expires_at`/`revoked_at` 保证，属 A9。

---

## A6 · 预算 / 限流（两开关独立） — ✅

**判定口径**：两个开关**互不影响**；限流拒绝一律带 `Retry-After`；预算 `observe` 档放行且照记，
`enforce` 档拒绝且信息里带 used/limit/window。

**验证方法**：起**三台**副本，每台只开一道闸门（或全关）。
这一点很关键——`RouterRateLimiter` 的桶按 project 分，预算作用域也落在 project 上，
**两道开在同一台上时先触发的那道会把后一道的用例全部染成 429**，看起来像「预算生效了」其实是限流。
一台一道，「独立」才是被测出来的而不是被假设的。

**命令 / 实测**

| 子项 | 配置 | 期望 | 实测 |
| --- | --- | --- | --- |
| 限流开 | `RATE_LIMIT_ENABLED=true`, `RPM=3`，连发 5 次 | 3×200 + 2×429 | ✅ 3×200、2×429 |
| 429 信封 | 同上 | 带 `Retry-After`，`error.type=rate_limit_error` | ✅ `Retry-After: 60` |
| 限流关 | `RATE_LIMIT_ENABLED=false` | 5 次全 200 | ✅ |
| 预算 observe | `enforce=false, limitUsd=0.000001` | 放行且 `llm_budget_usage` 持续累加 | ✅ 200；累加 1504.5 → 1520.3 USD |
| 预算 enforce | `enforce=true` | 429 + `Retry-After` + used/limit/window | ✅ `budget exceeded for project …: 1520.27/0.000001 USD (window=day)` |
| 两开关独立 | 预算已超限 **且** 限流桶已满 | 两道全关的副本仍全放行 | ✅ 5×200 |
| 两开关独立 | 同上 | 只开限流那台仍按**限流**判定 | ✅ 429（不是预算的信封） |

四种组合下「关掉的那一道**一次都不被调用**」由 `apps/llm-router` 的 `gates.test.ts` 用调用计数钉死
（本项证的是外部可观察行为，单测证的是内部没有被调用）。

**已知取舍**

1. **预算是软限额。** 本项为了可测把 `LLM_ROUTER_BUDGET_CACHE_MS` 设成 0；
   生产默认 10 s 缓存，高并发下会超出少量。要硬限额就设 0，代价是每次调用一次同步 DB 读。
2. **限流不是安全边界。** 复用 `RedisRateLimiter`，Redis 不可达时**降级放行**（可用性优先）。
   它是容量保护，不是配额执行。
3. 「控制面把网关 429 映射为 `RATE_LIMITED`」需要 `apps/web` 起着，**本次未测**。
4. `Retry-After` 在预算 `enforce` 档给的是**到窗口边界的秒数**（本次 59072 s ≈ 到月末，因为窗口是 `day`
   但用量早已远超限额、下一个可用窗口按实现取值）——数值大不代表错，但运维上建议给 `day` 窗口配合理的限额。

---

## A7 · 目录热变更（NOTIFY + 轮询兜底两组数据） — ✅

**判定口径**：生效时间 = 从目录写事务提交，到**所有健康副本**的下一次路由决策使用新目录。
**上界 = `max(NOTIFY 传播时延, LLM_CATALOG_POLL_MS) + 一次 loadSnapshot 耗时`。**

**验证方法**：不重启任何进程，插入一条新 alias，然后循环打它、记录第一次成功的时刻。
**两组数据缺一不可**——只给 NOTIFY 那组证明不了上界。

**命令 / 实测**

| 通路 | 方法 | 期望 | 实测 |
| --- | --- | --- | --- |
| NOTIFY 正常 | 标准写侧动作：`version++` 提交后 `pg_notify` | < 500 ms | **18 ms** |
| 轮询兜底 | 只 `version++`、**不发 `pg_notify`** | ≤ `POLL_MS` + 一次查询 | **1970 ms**（`POLL_MS=2000`） |

**已知取舍**

1. 轮询兜底那一组用「只 bump version、不发 `pg_notify`」来复现「NOTIFY 丢失 / LISTEN 断开」。
   **比 kill 掉 LISTEN 后端连接更确定**——postgres.js 会自动重连并重新订阅，kill 之后到底还收不收得到通知是竞态。
   两者对副本而言不可区分：副本看到的都是「版本位变了但没人通知我」。
2. 18 ms 是本机同容器内的 PG → 网关时延；跨可用区会更高，但上界仍由 `POLL_MS` 兜住。
3. 写侧**每个** POST/PATCH/DELETE 都必须调 `bumpCatalogVersion`，漏一个的话副本永远看不到那次变更——
   这一条由各 route 的单测逐个断言，不由本项覆盖。

---

## A8 · 密钥热变更（不重启生效 + 旧密钥不可还原） — ✅

**判定口径**：rotate 之后**不重启任何进程**，上游收到的就是新 key；库里检索不到任何一版明文，
也不留历史密文。

**验证方法**：先跑一次调用确认上游收到旧 key；然后按 rotate 路由的同一套动作
（覆盖 `sealed_value` + `version++` + `rotated_at` + `bumpCatalogVersion`）换成新 key；
不重启，循环调用直到上游看到新 key。

**命令 / 实测**

- 轮换前：上游 `Authorization: Bearer <旧 key>` ✅
- 轮换后**不重启**：上游 `Authorization: Bearer <新 key>` ✅
- `version` 1 → 2、`rotated_at` 已更新、`sealed_value` 被覆盖 ✅
- **无明文列**：`llm_credentials` 的列只有
  `id, name, alg, key_id, sealed_value, auth_style, auth_header, version, created_by, created_at, updated_at, rotated_at` ✅
- **无历史密文表**：`information_schema` 里 `llm_credential%` 只有 `llm_credentials` 一张 ✅
- 库里检索不到旧 key、也检索不到新 key ✅
- 网关日志里检索不到新 key ✅

**已知取舍**

1. **不保留历史密文是设计选择**（R4 §5.2）：轮换即覆盖，旧密钥从此不可还原。
   代价是「轮换后发现新 key 配错了」只能重新录入，没有一键回滚。
2. 生效时间与 A7 同源（目录版本位 + NOTIFY/轮询），因此上界也一样。
3. 轮换期间**已在途**的请求用的是取路由时那一份快照里的凭据——不会中途换 key（快照不可变）。

---

## A9 · 安全审计（探针 clean + 吊销流程） — 🟡

**判定口径**：供应商真 key 在**任何**非 llm-router 的位置都不得以明文出现；
凭据吊销有**确定的**生效上界。

**验证方法**：五处探针，每处**同时**查明文与它的 base64 形态（真实世界里最常见的泄漏不是
`console.log(key)`，而是某一层把整个凭据对象 JSON 化再 base64 丢进日志——只查明文会漏掉那一类）。
另外先制造一次「把密钥塞进 URL path / 自定义请求头 / `$.model`」的恶意请求，逼日志出口去清洗。

**命令 / 实测**

| # | 探针 | 结果 |
| --- | --- | --- |
| ① | 沙箱 env（run 真正拿到的那一份） | clean |
| ② | `llm_credentials` 全表 | clean |
| ③ | llm-router 进程日志（含 `sanitizingLogger` 清洗层） | clean |
| ④ | `run_events` 全量 | clean |
| ⑤ | 控制台凭据 API 的序列化结果 | clean |

另有：网关日志里**也没有** router 令牌明文（`rt_…` 在清洗模式里）。

**凭据吊销**

- run 令牌随 run 收敛自动吊销：A5 那条 run 的 3 枚令牌 `revoked_at` 均已写入 ✅
- 手动吊销的生效上界：先用一次让它进认证缓存，再置 `revoked_at`，循环打到 401 —— **实测 15.11 s**，
  与 `TokenAuthenticator` 的 15 s 缓存 TTL 吻合

**partial 的两处**

1. **「控制台 API 响应」没有走真实 HTTP**——本次未起 `apps/web`，改为对 `DrizzleCredentialStore.list()`
   的序列化结果取样（路由 handler 就是把它 JSON 化）。route 层另有 `route.test.ts` 断言响应体不含
   `value` / `sealed_value`。
2. **「部署清单里私钥的分布」需要 `kubectl`**，本机不可用。
   `scripts/audit-no-plaintext-key.sh` 里保留了该探针，跳过时会在输出末尾单独列出来。

**已知取舍**

1. **吊销生效是 ≤15 秒，不是「立即」。** 要更强保证就把 `LLM_ROUTER_TOKEN_TTL_MS` 设为 0
   （每次查库，多约 1–2 ms），或由控制面主动调 `TokenAuthenticator.invalidate()`。
2. **审计脚本的「跳过」不等于「通过」。** 脚本会把跳过的探针列出来；报告里必须照抄，
   否则一次「什么都没测」的运行会长得和「全部 clean」一模一样。

---

## A10 · 失败隔离（502 且不泄露） — ✅

**判定口径**：上游故障一律收敛成 502，错误体**只含供应商的 name**；上游自己的错误体**原样透传**，
不被网关的信封替换；一个供应商出问题不拖垮另一个。

**验证方法**：假上游支持 `?behavior=hang|reset|error429|error500`；另有一个 provider 指向确定没人监听的端口。

**命令 / 实测**

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 上游 connection refused | 502，body 只含 provider name | ✅ `{"type":"error","error":{"type":"api_error","message":"provider 'acc-dead-…' is unavailable"}}` |
| 同上，泄露检查 | 不含上游 host:port、不含 scheme+host、不含字面量 `baseUrl`、不含供应商密钥 | ✅（断言只报**标签**不报值——把密钥写进入库的 `results.json` 正是 A9 要抓的东西） |
| 上游 hang 超过 `timeoutMs` | 502 且连接释放 | ✅ 3003 ms 收尾（provider `timeoutMs=3000`） |
| 上游 429 + 自定义错误体 | 状态码与 body **逐字节**透传 | ✅ `{"upstream_says":"slow down","quota":{"reset_in":7}}`，**没有**被换成 `rate_limit_error` |
| 上游 500 + 非 JSON 错误体 | 同样原样透传 | ✅ |
| 8 条请求卡在超时里 | 健康路径不受影响 | ✅ 并发下健康路径 5 次全 200 |
| 失败也要计量 | 进 `llm_calls`，错误码只进库不回显 | ✅ 12 条 `upstream_error`，错误码 `UPSTREAM_FETCH_FAILED` / `UPSTREAM_TIMEOUT` / `UPSTREAM_HTTP_429` / `UPSTREAM_HTTP_500` |

**已知取舍**

1. 「另一个供应商不受影响」这一条，本次两个 provider 指向的是**同一个假上游进程**
   （不同 baseUrl 会引入端口差异这个额外变量）。因此证的是**网关侧没有共享阻塞队列**，
   不是「上游之间互不影响」——后者本来也不归网关管。
2. 真上游的故障注入不在本课题范围（不接现网）。
3. 泄露检查刻意**不查裸的端口号**：provider 名字里随便一个数字都会命中，
   那种「失败」只会教人把断言删掉，而不是发现真问题。

---

## A11 · 盲写 + 唯一持有（含堆快照对照实验） — 🟡

**判定口径**：录入即盲写；**web / control-plane 物理上不具备解封能力**；
沙箱拿到的只有短时令牌；接上网关不影响模型调用结果。

### ① 录入即盲写 — ✅

- 库里存的是密文（不含明文子串）
- 对外的凭据摘要既不含 `value` 也不含 `sealedValue`

### ② 结构性证明（这一项的主证据） — ✅

| 层面 | 断言 | 实测 |
| --- | --- | --- |
| 源码 | `apps/web` + `packages/control-plane` 里没有 `openSealed` / `LLM_ROUTER_PRIVATE`（排除测试） | 命中 0 |
| 构建产物 | `packages/control-plane/dist/index.js` 里 `openSealed` 命中 0 次 | ✅ |
| 依赖边界 | control-plane 只从 `@open-rush/llm-router/token` 子路径引入（模块图里只有 `node:crypto`） | ✅ |
| **导出面** | web 用的 `@open-rush/llm-router/sealing` 入口的全部导出是 `SEALED_BOX_ALG, computeKeyId, generateRouterKeyPair, seal` | ✅ **没有 `openSealed`** |
| 运行时 | 对照进程的 env 里没有任何私钥材料 | ✅ |

导出面那一条是最硬的：`sealing.ts` 的模块图里**物理上没有** `crypto/open-sealed.ts`，
不是靠 tree-shaking 侥幸摇掉的。

### ③ 堆快照对照实验 — 🟡 结论与 R6 的预期**不同**

R6 预期「router 侧 grep 得到明文（设计如此），对照组为空」。**实测两边都为空**：

| 进程 | 有私钥 | 堆里有明文 | 堆里有密文 |
| --- | --- | --- | --- |
| `apps/llm-router` | 是 | **否** | 是 |
| 对照进程（走 web 侧同一条代码路径） | 否 | 否 | 是 |

原因：`--heapsnapshot-signal` 在写快照前会先做一次 **full GC**，而解封出来的明文只活在 `forward()` 的栈上、
组完请求头就断开引用（C4 §7.8），到不了快照里。

**这比预期更强，但也意味着堆快照不能用来证明「只有 router 能解」**——它只能证明「明文不驻留」。
「只有 router 能解」的证据是另外三条：

- **A8**：rotate 之后上游立刻收到新 key。只有持私钥的进程做得到这件事。
- **②** 的结构性证明：源码、构建产物、导出面三重。
- **D3 的非对称设计本身**：不是「我们约定不解」，而是「没有私钥就解不了」。若用对称 KEK，
  这一条只能靠代码审查来保证，说服力弱一个量级。

> 复现这个实验时有一个坑：**绝不能把明文当参数传给对照进程**——那样明文会以 argv 字符串的形式
> 活在它的堆里，快照必然命中，而这命中与「能不能解封」毫无关系。本套件让对照进程只报出快照路径，
> grep 由驱动进程来做。

### ④ 沙箱边界 — ✅

- 沙箱 env 里**没有**供应商真 key
- 沙箱 env 里有 `ANTHROPIC_BASE_URL`（指向网关）
- 沙箱拿到的是 `rt_` 前缀的**短时**令牌（随 run 吊销）

### ⑤ 不影响大模型调用 — ✅

同一请求分别走「直连假上游」与「经网关」：

- 两条路径都 200
- SSE 事件类型序列一致：`message_start → content_block_start → ping → content_block_delta ×2 → content_block_stop → message_delta → message_stop`
- 最终文本一致：`等于 2 🚀`
- **并且逐字节一致**

**已知取舍**

1. 对照组不是真的 `apps/web` 进程（起一个 Next.js server 只为取一次堆快照代价太高），
   而是一个**没有私钥、走 web 侧同一条代码路径**（读密文 + 只 import `@open-rush/llm-router/sealing`）的子进程。
2. **私钥丢失不可恢复。** 唯一恢复路径是重新生成密钥对并**重新录入全部供应商密钥**——
   见 [`docs/llm-router.md`](./llm-router.md) 的「私钥丢失」一节。

---

## 汇总

| 指标 | 结论 | 关键证据 | 取舍 / 备注 |
| --- | --- | --- | --- |
| A1 | ✅ | 请求 363 B / 响应 977 B 逐字节一致；未知 beta 头原样到达上游 | gzip 上游未实测；translate 只交付一个方向，10 条有损项见 R9 §9.6 |
| A2 | 🟡 | 并发 1 ΔTTFB p95 = 2.77 ms | 并发 8/32 超 15 ms，是 4 核单机三进程抢 CPU 的产物，不是网关开销；按 D11 横向扩 |
| A3 | ✅ | 504 次请求零 5xx；在途流字节完整；`exit 0` | 超长流受 drain 窗口限制 |
| A4 | ✅ | 12 条目录 + 3 个未知 alias 全部命中预期 | 并列 priority 只保证确定性，不保证选中哪一条 |
| A5 | ✅ | 3 行 ↔ 聚合 7200/126/5.247 ↔ `run_events` 三方一致 | Anthropic 推理 token 协议层不可拆；**聚合与批写存在竞态**（已登记后续项） |
| A6 | ✅ | 限流 3/5 + `Retry-After`；预算两档；三台副本证独立 | 预算是软限额；限流 Redis 挂了降级放行 |
| A7 | ✅ | NOTIFY **18 ms** / 轮询兜底 **1970 ms**（poll=2000） | 轮询组用「不发 NOTIFY」复现，比 kill LISTEN 更确定 |
| A8 | ✅ | 不重启即生效；无明文列、无历史表 | 不保留历史密文是设计选择，没有一键回滚 |
| A9 | 🟡 | 5 处探针 clean；吊销生效实测 **15.11 s** | 控制台 API 与 k8s 清单两处探针本机未测；吊销是 ≤15 s 不是立即 |
| A10 | ✅ | 502 不泄露；上游错误体原样透传；无共享阻塞 | 两个 provider 共用一个假上游进程 |
| A11 | 🟡 | 源码 + 产物 + 导出面三重证明；沙箱只有 `rt_` 令牌 | 堆快照对照的结论与 R6 预期不同（两边都为空），已改用 A8 + 结构性证明支撑 |

**pass 8 · partial 3 · fail 0。**

---

## 相关文档

- [`e2e/llm-router/README.md`](../e2e/llm-router/README.md) — 复现步骤与可调开关
- [`docs/llm-router.md`](./llm-router.md) — 部署、密钥生成与轮换、目录配置、故障排查
- [`specs/llm-router.md`](../specs/llm-router.md) — 设计决策的 source of truth
- [`docs/plans/llm-router/ref/R6-验收自证.md`](./plans/llm-router/ref/R6-验收自证.md) — 本文的判定口径出处
- [`docs/plans/llm-router/ref/R7-风险与上线.md`](./plans/llm-router/ref/R7-风险与上线.md) — 风险登记与上线路径
