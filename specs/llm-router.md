# LLM Router Specification

> **相关 Spec**：[`credential-proxy.md`](credential-proxy.md)（通用 HTTP 凭据 sidecar，**互补不冲突**，见 §与 credential-proxy 的关系）、[`vault-design.md`](vault-design.md)（既有双层 Vault，**并存不耦合**）、[`security-baseline.md`](security-baseline.md)、[`agent-worker.md`](agent-worker.md)、[`service-token-auth.md`](service-token-auth.md)

`apps/llm-router` 是一层**极薄的统一模型路由网关**：所有 LLM 调用收敛到这一层，对外呈现供应商无关的模型入口，同时承载密钥收敛、逐调用计量、预算与限流。

本文件记录的是**方向性选择**（落位、协议承诺、密钥边界、热变更语义、错误信封分层），不是实现说明书。实施计划见 `docs/plans/llm-router/`。

## Status

**Accepted**（M0 定稿）· 实施进行中，按 M0–M7 分阶段落地。

## 设计原则

- 网关**不改写语义**：不做提示词加工，不解释 body，除显式声明的例外（§协议承诺分层）外逐字节透传。
- 密钥**结构性隔离**：不是"约定不解密"，而是"没有私钥就解不了"。
- 计量**旁路**：计量、预算写入失败不阻塞上层调用。
- 装配**可选**：不装配 `llmAccess` 时，Run 链路行为与改造前完全一致。

---

## 落位（D1）

```
control-worker ──SSE①── agent-worker ── Claude Code CLI ──▶ [ llm-router ] ──▶ 供应商
                                          ↑ ANTHROPIC_BASE_URL 指到这里
```

网关夹在 **Claude Code CLI 与供应商之间**，不是夹在 control-worker 与 agent-worker 之间。独立服务 `apps/llm-router`（Hono，默认 `:8790`），无状态多副本。

**为什么这条落位不破坏既有协议**：

| 既有资产 | 是否经过网关 | 结论 |
|---|---|---|
| SSE①（agent-worker → control-worker） | 否 | 一个字节不变 |
| SSE②（control-api → browser） | 否 | 一个字节不变 |
| 15 状态 Run 状态机 | 否 | 转换规则不变 |
| `run_events` 既有事件类型 | 否 | 不新增、不改语义（`data-openrush-usage` 是既有 schema 的首个生产者，见 §计量） |

网关位于 Claude Code CLI 的下游，对 OpenRush 的双层 SSE 与状态机**完全不可见**。接入方式是 Claude Code 官方 gateway 协议（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`），不发明私有协议。

---

## 决策台账（D1–D12）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | 网关落位 | 独立服务 `apps/llm-router`（Hono，:8790），夹在 Claude Code CLI ↔ 供应商之间 | 双层 SSE 与状态机完全不经过网关；这正是官方 gateway 协议的接入点 |
| D2 | 对外协议面 | 同时暴露 Anthropic Messages（`/v1/messages`）与 OpenAI（`/v1/chat/completions`）；上游适配分 `passthrough` / `translate` | "body 零改写"与"异构供应商"在跨协议时不可兼得，必须显式分层承诺 |
| D2b | 模型名改写 | 默认 `alias == upstream_model` → 字节级零改写；异名时进入 `rewrite-model`，**只允许改 `$.model` 一个字段** | 把零改写的例外收敛成一个可被单测精确断言的点 |
| D3 | 密钥盲写 | **非对称信封**：web 只持公钥 `LLM_ROUTER_PUBLIC_KEY`，llm-router 独占私钥 `LLM_ROUTER_PRIVATE_KEY`；算法 `X25519 + HKDF-SHA256 + AES-256-GCM`，Node 内置零依赖 | web 在物理上不具备解密能力；对称 KEK 做不到这点 |
| D4 | 与既有 Vault 的关系 | **并存不耦合**：llm-router 凭据走 `llm_credentials` + 非对称信封，`vault_entries` 保持原样 | Vault 的对称 KEK 由部署侧持有、web 可解密，与"录入即盲写"根本冲突 |
| D5 | 调用方凭据 | 新表 `llm_router_tokens`，per-run 短时令牌（存 SHA-256）；复用 `service_tokens` 的范式不复用表 | `service_tokens.owner_user_id NOT NULL` + v1 scope 枚举是对外契约；机器凭据的生命周期（分钟级、随 run 吊销）与之不同 |
| D6 | 归属（subject）来源 | **令牌即归属**；`x-claude-code-session-id` / `-agent-id` 只作分组提示 | 沙箱内 agent 有 bash，能改 env 与 header；只有令牌是我们签发且可验证的 |
| D7 | 目录/凭据热变更 | DB 唯一真相 + 进程内快照 + `LISTEN/NOTIFY` + 轮询兜底（`LLM_CATALOG_POLL_MS`，默认 5000） | NOTIFY 亚秒级；轮询兜底保证连接抖动/新副本仍能收敛，生效时间有确定上界 |
| D8 | 计量 | 逐调用写 `llm_calls`（异步批写、失败不阻塞）；run 收敛时由 control-worker 聚合回写 `data-openrush-usage` | 计量失败不得阻塞转发；聚合回写把新表接回既有事件契约 |
| D9 | 预算 / 限流 | 限流复用 `packages/agent-runtime` 的 `RedisRateLimiter`；预算用 `llm_budget_usage` DB 累计器 + 进程内缓存，`observe` / `enforce` 两档 | 限流是请求计数（Redis 天然合适），预算是金额累计（需持久、需跨重启） |
| D10 | 错误面 | 三套信封各司其职（见 §错误信封三分法） | Claude Code 的自动降级重试按上游错误文案匹配，包一层会破坏恢复路径 |
| D11 | 高可用 | 无状态多副本；`/healthz`（存活）+ `/readyz`（就绪）；SIGTERM 后停收新请求、等待在途流最多 `DRAIN_TIMEOUT_MS` | SSE 长连接是滚动更新的唯一难点，靠 readiness 摘流 + 优雅 drain 解决，不需要粘性会话 |
| D12 | 出网收敛 | MVP **不依赖**沙箱网络策略：沙箱内没有任何真 key，绕过网关也调不通供应商 | 去掉对 OpenSandbox `patchEgressRules`（尚未实现）的硬依赖 |

推翻任何一条：先改 `docs/plans/llm-router/01-进度.md` 的「决策变更记录」，再改本 Spec，最后才动代码。

---

## 协议承诺分层（D2 / D2b）

这是本方案最重要的诚实性声明：**"请求 body 零改写"与"支持异构供应商"在跨协议时数学上不可同时满足**，因此按模式分层承诺。

| 模式 | 触发条件 | 透传承诺 | 计量 | MVP 是否交付 |
|---|---|---|---|---|
| `passthrough` | 调用方协议 == 上游协议，且 `alias == upstream_model` | **请求/响应 body 逐字节一致**；SSE 事件不丢不改序 | 旁路 tee | ✅ 必交 |
| `rewrite-model` | 同协议，`alias != upstream_model` | 除 `$.model` 一个字段外，解析后对象**深度相等** | 旁路 tee | ✅ 必交 |
| `translate` | 调用方协议 != 上游协议（Anthropic-in → OpenAI-out） | **不承诺零改写**；承诺语义等价 + 流式不丢事件 | 旁路 tee | 🟡 Stretch，可裁剪 |

`translate` 若被裁剪，必须在验收报告里如实说明，不得含糊为"尽量不改写"。

### 透传的硬性细节

- 上游响应 body **逐字节转发**，包括 SSE `ping` 事件与注释行——Claude Code 有 300 秒字节级看门狗，缓冲或吞掉 ping 会中断长思考期间的流。
- 向上游发 `accept-encoding: identity`，不请求压缩，避免解压/再压导致字节不一致。
- 请求头走**开放列表**转发（`anthropic-*` / `x-claude-code-*` 默认转发），**禁止白名单过滤**——过滤会在 Claude Code 新版本发布时静默打断新能力。
- `Authorization` / `x-api-key` 是 router 令牌，**消费掉，绝不转发上游**；hop-by-hop 头（`connection` / `transfer-encoding` / `keep-alive` / `upgrade` / `te` / `trailer` / `proxy-*`）剥离。

---

## 密钥边界

### 盲写不变量（4 条，不可违反）

1. **`llm_credentials` 没有任何明文列**，也不存在能把密文解回明文的对称密钥落在 web / control-plane 侧。
2. `sealed_value` 由 apps/web 用 `LLM_ROUTER_PUBLIC_KEY` **单向封装**；对应私钥只存在于 llm-router 进程内存，web 侧**物理上无法解封**。
3. `/api/v1/llm/credentials` 的任何响应**永不包含** `sealed_value` 或明文 `value`。
   契约层是**类型层**的第一道闸门：`llmCredentialSchema` 结构上没有这两个键
   （`packages/contracts/src/v1/llm-router.ts`），但它**不会自动作用于响应体**——
   `v1Success<T>(data: T)` 是无约束泛型，不跑 schema。所以运行时的保证由两件事承担，
   M2·T2.3 必须同时做到：① 路由用显式投影函数 `credentialToV1()` 构造响应
   （范式见 `/api/v1/vaults/entries` 的 `entryToV1()`，同样是手写投影挡住 `encryptedValue`）；
   ② `route.test.ts` 断言真实响应体里检索不到 `sealedValue` / `value`。
4. 轮换 = 覆盖 `sealed_value` + `version++` + `rotated_at=now()`，**不保留历史密文**（保证"旧密钥不可从持久层还原"）。

明文供应商 key 的**唯一**允许出现位置：llm-router 进程内存，且只在单次转发的调用栈上流转，用完置空；不进任何缓存、日志、响应。web / control-worker / agent-worker / 沙箱 env / DB / 日志 / 响应体，一处都不得有。

### 沙箱侧拿到的是什么

per-run 短时令牌（`rt_*`），不是供应商真 key。即使 agent 在沙箱里有 bash，能读到的也只是一个分钟级、随 run 吊销、只能打到本网关的令牌（D12：没有钥匙就没有门）。

### ⚠️ 依赖版本漂移风险（必须显式抹除，不能靠"不设置就没有"）

`ai-sdk-provider-claude-code` 在 **3.4.4 → 3.6.0** 之间反转了子进程 env 的继承行为：

| 版本 | 子进程 env 来源 | 后果 |
|---|---|---|
| 3.4.4（当前锁定） | 窄白名单：平台基础变量 + `CLAUDE_CONFIG_DIR`，**不含 `ANTHROPIC_*`** | 不设置就不会有 |
| 3.6.0+（`@anthropic-ai/claude-agent-sdk` 0.3.x） | 白名单新增**前缀匹配**：`ANTHROPIC_` / `CLAUDE_` / `AWS_` / `GOOGLE_` 全部继承 | 容器里任何 `ANTHROPIC_API_KEY` 会**自动泄漏进子进程** |

因此 `apps/agent-worker/src/server.ts` 必须**显式置 `undefined`**，而不是依赖"没有拷贝就没有"：

```ts
const providerEnv: Record<string, string | undefined> = {
  ...(env ?? {}),
  // 显式抹除：3.6.0+ 的白名单会前缀继承 ANTHROPIC_*/AWS_*。
  // undefined 是硬保证，不随 provider 版本漂移。
  ANTHROPIC_API_KEY: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
};
```

配套一条版本回归测试：断言子进程 env 中不存在这些键。升级 provider 依赖时该测试是第一道闸门。

---

## 归属与令牌（D5 / D6）

- **令牌即归属**：`llm_router_tokens` 行上绑定 `runId` / `agentId` / `projectId` / `ownerUserId` / 允许的 `modelAlias`，计量与授权只认令牌。
- `x-claude-code-session-id` / `-agent-id` / `-parent-agent-id` **只作分组提示**记入 `llm_calls`，不作授权与计费依据——沙箱内可以随意伪造它们。
- 令牌明文只在签发那一刻可见一次，库里存 SHA-256。
- 生命周期：随 run 签发，run 收敛时吊销。**吊销生效上界 = `TokenAuthenticator` 缓存 TTL**（默认 15s），这个上界要写进验收报告，不能只说"立即生效"。

---

## 热变更（D7）

**唯一真相是 DB**，进程内只有快照缓存。写路径（每个目录/凭据的 POST/PATCH/DELETE）必须：

1. 在同一事务内 `UPDATE llm_catalog_state SET version = version + 1`；
2. **事务提交后**再 `pg_notify('llm_catalog', version)`。

漏掉 bump 的后果是副本永远看不到变更——这是本模块最容易漏的一步，每个写路由都要有对应测试。

**生效时间定义**：从目录写事务提交，到**所有健康副本的下一次路由决策使用新目录**。

**上界** = `max(NOTIFY 传播时延, LLM_CATALOG_POLL_MS) + 一次 loadSnapshot 耗时`。

轮询兜底不是冗余：LISTEN 连接抖动或新副本冷启动时，它是收敛的唯一保证。验收要求分别给出 NOTIFY 正常时与**故意断开 LISTEN 连接**后的两组实测数据——两组一起给，才算证明了"生效时间有确定上界"。

密钥轮换走同一条通道：覆盖 `sealed_value` → bump version → NOTIFY，副本不重启即生效。

---

## 错误信封三分法（D10）

| # | 场景 | 处理 | 为什么 |
|---|---|---|---|
| ① | **上游错误** | **原样透传**，字节不改，不包信封 | Claude Code 的能力降级重试按上游错误文案匹配，包一层就破坏恢复路径 |
| ② | **网关自身错误** | 按**调用方协议**成形：Anthropic 面 `{type:"error",error:{type,message}}`；OpenAI 面 `{error:{code,message}}` | 调用方只认自己协议的错误形状 |
| ③ | **控制台 API 错误** | 仓库既有 v1 信封 `{error:{code,message}}` | 与 `/api/v1/*` 现有契约一致 |

网关自身错误的码位（②）：

| 场景 | HTTP | Anthropic `error.type` | OpenAI `error.code` | `llm_calls.status` |
|---|---|---|---|---|
| 令牌缺失/无效/过期/吊销 | 401 | `authentication_error` | `invalid_api_key` | `unauthorized` |
| 令牌不允许该 alias | 403 | `permission_error` | `insufficient_permissions` | `forbidden` |
| 未知/未启用 alias | 404 | `not_found_error` | `model_not_found` | `model_not_found` |
| 非法 JSON / 缺 `model` | 400 | `invalid_request_error` | `invalid_request_error` | `router_error` |
| 限流 | 429 | `rate_limit_error` | `rate_limit_exceeded` | `rate_limited` |
| 预算超限（enforce） | 429 | `rate_limit_error` | `rate_limit_exceeded` | `budget_exceeded` |
| 上游不可达/超时 | 502 | `api_error` | `upstream_error` | `upstream_error` |
| 网关内部错误 | 500 | `api_error` | `internal_error` | `router_error` |

- 429 一律附带 `Retry-After` 秒数（限流取滑动窗口剩余时间，预算取到窗口边界的秒数）。
- 控制面若需把网关 429 冒泡给上层 `/api/v1/*`，映射到既有的 `RATE_LIMITED`（`packages/contracts/src/v1/common.ts`，HTTP 429）。
- 502 的响应体不得回显上游 URL、凭据名或任何头部内容。

---

## 计量、预算、限流（D8 / D9）

- llm-router 逐调用写 `llm_calls`：subject（来自令牌）、alias、协议、模式、token 四类计数、`cost_usd`、TTFB、总耗时、状态。**异步批写，失败只记日志不阻塞转发。**
- control-worker 在 run 收敛时聚合 `llm_calls` 回写 `data-openrush-usage` 事件——该事件的 zod schema 早已存在于 `packages/contracts/src/v1/runs.ts`，但在本课题之前**没有任何生产者**。所以这是"从零到有"，不是升级。
- 预算：`llm_budgets`（作用域 `global` / `project` / `user` / `agent`，窗口 `day` / `month` / `total`）+ `llm_budget_usage` DB 累计器 + 进程内缓存，两档开关 `observe`（只记不拦）/ `enforce`（拦截）。作用域解析优先级 `agent → project → user → global`，取最近的一档。
- 限流：复用 `packages/agent-runtime` 的 `RedisRateLimiter`（Redis Lua 滑动窗口，多副本共享），key = subject。
- 两个开关**互相独立**：限流开/预算关、限流关/预算开都必须各自正确。

---

## 可用性与部署（D11）

- 无状态多副本，共享状态全在 PostgreSQL / Redis。
- `GET /healthz`：只查进程存活。
- `GET /readyz`：私钥已加载 **且** 目录快照非空 **且** DB 可达。滚动更新靠它摘流。
- SIGTERM 后停收新请求，等待在途 SSE 流最多 `DRAIN_TIMEOUT_MS`，然后退出。
- `GET /v1/models` 必须在 **3 秒内响应且不得重定向**（含 http→https），否则 Claude Code 的模型发现会静默失败。
- `HEAD /api/hello` 返回 200（连接预热探针，不实现会在日志刷 404）。

---

## 契约与 Scope

- 类型契约：`packages/contracts/src/v1/llm-router.ts`（zod **v3** API，仓库锁定 `zod@3.25.76`）。
- `ServiceTokenScope` 追加 `llm:read` / `llm:write`（同步更新 `specs/service-token-auth.md` 的 scope 矩阵）。
- 控制台 API 面 `/api/v1/llm/*` 沿用既有 v1 规范：`authenticate()` + `hasScope()` + `v1Success` / `v1Error` / `v1Paginated`。
- **平台级资源限制**：`credentials` / `providers` / `models` 无 `projectId`，属平台级，按仓库既有惯例（见 `/api/v1/vaults/entries` 对 `scope=platform` 的处理）**仅接受 session 认证，拒绝 service token**。`llm:read` / `llm:write` 因此服务于 `budgets` / `calls` 这两个面——注意预算本身有 `global` / `project` / `user` / `agent` 四档作用域（见 §计量、预算、限流），不是只有项目级；service token 能读写哪几档，由 M5 的资源归属校验决定，不由 scope 单独决定。

---

## 与 `credential-proxy.md` 的关系

两者解决同一类问题（密钥不进沙箱），但形态不同，**互补而非替代**：

| | `credential-proxy`（Deferred） | `llm-router`（本 Spec） |
|---|---|---|
| 形态 | 通用 HTTP 转发 sidecar | **协议感知**的模型网关（独立服务） |
| 覆盖面 | 任意 HTTP 凭据（GitHub / S3 / OpenAI…） | 只覆盖 LLM 调用 |
| 逐调用计量 | 否（不解析 body / SSE） | **是** |
| 模型目录与路由 | 否 | **是** |
| 部署耦合 | 与沙箱 1:1，需 iptables 强制出网 | 独立多副本，无沙箱侵入 |

llm-router 落地后，`credential-proxy.md` 的适用范围收窄为**非 LLM 的 HTTP 凭据**。它仍是 Deferred，不因本课题作废。

与 `vault-design.md` 的关系见 D4：**并存不耦合**，不改造 Vault，llm-router 不依赖 Vault。

---

## 绝对边界（不做）

- ❌ 不改写请求/响应语义（不做提示词加工）
- ❌ 不改 agent-worker 与 Claude Code 的既有调用语义（只换 `ANTHROPIC_BASE_URL` 指向）
- ❌ 不改双层 SSE 协议、不改 15 状态机、不改 `run_events` 既有事件类型
- ❌ 不重构 `packages/agent-runtime`（当前是死代码，只复用其中的 `RedisRateLimiter`）
- ❌ 不改造既有 Vault
- ❌ 不引入完整审计表；`llm_calls` 兼作调用审计源（`AuditAction` 枚举补值以便未来接入）

---

## 验收指标

| 指标 | 内容 |
|---|---|
| A1 | 透传语义（body 零改写 + SSE 不丢不改序） |
| A2 | 转发性能（p95 附加延迟，TTFB 与总耗时分开报） |
| A3 | 可用性（滚动更新不中断） |
| A4 | 路由准确率（100% / 未知 alias 404） |
| A5 | 明细计量（逐调用 + subject + 与 run 级对账） |
| A6 | 预算 / 限流（两开关独立） |
| A7 | 目录热变更（NOTIFY + 轮询兜底两组数据） |
| A8 | 密钥热变更（不重启生效 + 旧密钥不可还原） |
| A9 | 安全审计（明文探针 clean + 吊销流程） |
| A10 | 失败隔离（502 且不泄露） |
| A11 | 盲写 + 唯一持有（含堆快照对照实验） |

方法与命令见 `docs/plans/llm-router/ref/R6-验收自证.md`；结果落 `docs/llm-router-acceptance.md`。
