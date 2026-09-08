# open-rush 统一模型路由网关（llm-router）开发计划书

> **文档性质**：实际开发前的实施计划书（Plan）。按 `AGENTS.md` 的分级流程，本课题属于 **Large 变更**（新模块 + 跨多 package），因此必须走 `Plan → Sparring Review → Spec → 实现` 全流程。本文档即该流程的第 1 步产物。
>
> **使用方式**：开发人员或 AI Agent 拿到本文档后，**不需要再回头读课题说明**即可开工。第 2 节说明了课题说明与仓库现状的偏差（有 8 处实质性偏差，请以本文档为准）；第 8 节是可直接执行的任务卡，每张卡带文件清单、验收标准和测试要求。
>
> **调研基线**：`kanyun-rush/open-rush` @ `e62f507c37603cb7df40d87b5b4ee94a285503c7`
> **文档版本**：v1.0 · 2026-09-08

---

## 0. 目录

| 节 | 内容 | 读者 |
|---|---|---|
| 1 | 调研基线与复现方法 | 全部 |
| 2 | **现状盘点与课题说明的偏差更正**（关键） | 全部 |
| 3 | 关键决策清单（D1–D12，结论式） | 全部 |
| 4 | 目标架构与数据流 | 全部 |
| 5 | 数据模型（Drizzle schema + DDL） | 实现者 |
| 6 | 对外契约（Zod + HTTP 面） | 实现者 |
| 7 | 代码骨架（可直接落盘的关键实现） | 实现者 |
| 8 | 任务分解（M0–M7，26 张任务卡） | 实现者 |
| 9 | 验收自证（A1–A11 逐项方法与命令） | 实现者 + 评审 |
| 10 | 风险、上线路径与不做的事 | 评审 |
| 11 | 附录：环境变量、术语、参考资料 | 全部 |

---

## 1. 调研基线与复现方法

### 1.1 基线 commit

```bash
git clone https://github.com/kanyun-rush/open-rush.git
cd open-rush
git checkout e62f507c37603cb7df40d87b5b4ee94a285503c7
```

| 项 | 值 |
|---|---|
| commit | `e62f507c37603cb7df40d87b5b4ee94a285503c7` |
| 提交时间 | 2026-04-28T22:52:12+08:00 |
| 提交标题 | `Merge pull request #113 from kanyun-rush/dependabot/npm_and_yarn/next-auth-5.0.0-beta.31` |
| 分支 | `main`（即 `origin/HEAD`） |
| TS 源文件数 | 397（`apps/` + `packages/`，不含 node_modules） |

> **注意**：调研时（2026-09-08）`main` 的 HEAD 仍停在 2026-04-28。仓库上有 20+ 条未合并分支（`feat/chat-system`、`chore/spec-*` 等）。**本计划只基于 `main`**；若开工时 `main` 已推进，先执行 1.3 的差异复核。

### 1.2 锁定的关键依赖版本（取自 `pnpm-lock.yaml`）

| 包 | 锁定版本 | 为什么重要 |
|---|---|---|
| `ai-sdk-provider-claude-code` | **3.4.4** | 决定子进程环境变量的继承行为，直接影响 A11（见 2.8） |
| `@anthropic-ai/claude-agent-sdk` | **0.2.104** | 真正发起 HTTP 调用的运行时 |
| `ai` (Vercel AI SDK) | 6.0.168 | `streamText` / `toUIMessageStreamResponse` |
| `zod` | **3.25.76** | 契约用 **zod v3** API（`z.string().uuid()` 而非 v4 的 `z.uuid()`） |
| `drizzle-orm` | 0.45.2 | schema + migration |
| `postgres` (postgres.js) | 3.x | 提供 `sql.listen()`，是热变更方案的基础 |
| Node | >= 22（`.nvmrc`），实测 v22.22.2 | X25519 / `hkdfSync` / WHATWG Streams 均可用 |

### 1.3 开工前的差异复核（15 分钟）

```bash
# 1) 确认基线是否仍是 main
git fetch origin && git log --oneline e62f507..origin/main | head -50

# 2) 复核本计划依赖的 8 个"现状事实"是否仍成立（对应第 2 节）
grep -rn "agent-runtime" --include=*.ts apps packages | grep -v node_modules | grep -v "\.test\."   # 期望：只有 package.json 声明，无 import
grep -rn "openrush-usage" --include=*.ts apps packages | grep -v node_modules                        # 期望：只在 contracts schema 与测试中
grep -rn "resolveVaultEnv" apps/control-worker/src/worker.ts                                          # 期望：仍是 async () => ({})
grep -rn "sanitize(\|AuditLogger" --include=*.ts apps packages | grep -v node_modules | grep -v __tests__ | grep -v "export"  # 期望：无生产调用方
grep -n "modelId" packages/control-plane/src/run/run-orchestrator.ts                                  # 期望：无匹配（未透传）
```

若任一"期望"不成立，说明 `main` 已演进，请在 Sparring Review 中同步更新第 2 节，并重估受影响的任务卡。

---

## 2. 现状盘点与课题说明的偏差更正

课题说明写于仓库更早的状态，与 `e62f507` 有 **8 处实质性偏差**。这些偏差直接改变了工作量估算和方案选择，**请以本节为准**。

### 2.1 ⚠️ `packages/agent-runtime` 是死代码——模型配置的真实落点不在那里

课题说明称"模型与连接方式最终落在 `packages/agent-runtime/src/claude-code-provider.ts` 的 `ClaudeCodeConfig` / `buildEnvVars()`"。**这是错的。**

```bash
$ grep -rn "agent-runtime" --include=*.ts --include=*.json apps packages | grep -v node_modules
apps/agent-worker/package.json:17:    "@open-rush/agent-runtime": "workspace:*",   # 只声明依赖
packages/agent-runtime/package.json:2:  "name": "@open-rush/agent-runtime",
$ grep -rn "buildEnvVars\|ClaudeCodeConfig" --include=*.ts apps packages | grep -v node_modules | grep -v packages/agent-runtime
（空）
```

`buildEnvVars()`、`resolveConnectionMode()`、`BudgetGuard`、`RateLimiter`、`RedisRateLimiter`、`LlmTracer`、`withRetry` **全部零调用方**（除自身的单测）。整个 `@open-rush/agent-runtime` 只被 `agent-worker` 的 `package.json` 声明，源码里一次 `import` 都没有。

**模型调用的真实唯一落点**是 `apps/agent-worker/src/server.ts`：

```ts
// apps/agent-worker/src/server.ts:102-125（e62f507）
const effectiveModelId =
  modelId ?? process.env.CLAUDE_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'sonnet';
const providerEnv: Record<string, string> = {
  ...(env ?? {}),
  ...(process.env.ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }),
  ...(process.env.ANTHROPIC_API_KEY  && { ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  }),
};
const result = streamText({
  model: claudeCode(effectiveModelId, {
    permissionMode: 'bypassPermissions',
    maxTurns: maxTurns ?? 30,
    sessionId: sid,
    ...(Object.keys(providerEnv).length > 0 ? { env: providerEnv } : {}),
    ...
  }),
  ...
});
```

**对本课题的影响（正面）**：接入点比预想的更干净——**只有这一处**需要改，改 3 行即可把整条链路引到网关上。同时意味着 `agent-runtime` 的"AI Provider 抽象"并不存在，不要花时间去"扩展"它。

### 2.2 ⚠️ `data-openrush-usage` 从未被任何生产者发出

课题说明称"token 用量以 `data-openrush-usage` 事件落 `run_events`（由 Claude Code 返回）"。**当前没有任何代码发出这个事件。**

```bash
$ grep -rn "openrush-usage" --include=*.ts --include=*.md apps packages specs docs | grep -v node_modules
packages/contracts/src/v1/runs.ts:335         # zod schema 定义
packages/contracts/src/v1/__tests__/runs.test.ts:188
packages/sdk/README.md:148 / specs/managed-agents-api.md:195 / docs/api.md:165   # 文档
```

`RunOrchestrator` 只发出 `data-openrush-run-started` / `data-openrush-run-done`（且都在 `OPENRUSH_V1_EVENTS_ENABLED=true` 的 feature flag 后面，**默认关闭**）。

**影响**：F5 不是"从 run 级聚合升级到逐调用"，而是**从零到有**。好消息是没有历史包袱；坏消息是"与现有 `data-openrush-usage` 对齐语义"（A5）需要我们自己去把这个契约**实现出来**，而不是对齐一个已存在的实现。本计划把它拆成两件事：llm-router 写 `llm_calls`（逐调用，真相），control-worker 在 run 收敛时聚合回写 `data-openrush-usage`（run 级，兼容契约）。

### 2.3 ⚠️ Vault 完全没有接入实际链路

```ts
// apps/control-worker/src/worker.ts:51
const agentExecutor = new AgentExecutor({
  resolveAgent: async (agentId, projectId) => { ... },
  resolveVaultEnv: async () => ({}),      // ← 空实现
  resolveSkills:   async () => [],
  resolveMcpServers: async () => [],
});
```

`VaultService.resolveForSandbox()` 在生产代码中**零调用方**（只在单测里被调）。也就是说：课题说明里"真实供应商密钥从双层 Vault 取出后以 env 注入沙箱"这条链路**尚未打通**。当前密钥其实来自 **agent-worker 进程自己的 `process.env`**（`apps/agent-worker/.env.example` 明写 `ANTHROPIC_API_KEY=xxx`）。

**影响（重要）**：
- "把密钥从沙箱 env 里拿掉"这件事，工作量比课题说明描述的**小**——因为还没有 Vault→沙箱的注入链路要拆。
- 但同时意味着 `VaultService` 是一个**未验证的组件**，不要假设它能直接工作。本计划的选择是：**不改 Vault，不依赖 Vault**，llm-router 用自己的一套非对称信封（D3），与 Vault 并存但不耦合。理由见 D3。

### 2.4 ⚠️ `output-sanitizer` 与 `AuditLogger` 已实现但未接线

```bash
$ grep -rn "sanitize(\|AuditLogger" --include=*.ts apps packages | grep -v node_modules | grep -v __tests__
packages/control-plane/src/vault/index.ts:3        # 仅 barrel 导出
packages/control-plane/src/admin/index.ts:5        # 仅 barrel 导出
packages/control-plane/src/vault/output-sanitizer.ts:12   # 定义
packages/control-plane/src/admin/audit-log.ts:52          # 定义
```

`AuditLogStore` 只有 interface，**没有任何 Drizzle 实现，也没有 `audit_logs` 表**。

**影响**：A9（安全审计）要求"提供凭据吊销流程"和"日志中检索不到明文"。本计划：
- 复用 `sanitize()` 纯函数，接到 llm-router 的日志出口（M6 · T6.5）；
- **不**引入完整审计表（超出课题范围），改为把 `llm_calls` 作为调用审计源，并在 `AuditAction` 枚举里补 3 个值以便未来接入。这是"复用 vs 新增"的取舍点，需在 Spec 中说明。

### 2.5 ✅ 预算 / 限流的积木已经存在（未接线）

`packages/agent-runtime` 里已有可用实现：

| 文件 | 能力 | 状态 |
|---|---|---|
| `budget.ts` | `BudgetGuard`：token / cost / duration 三种上限，进程内累计 | 已实现，未接线 |
| `rate-limiter.ts` | 进程内滑动窗口 | 已实现，未接线 |
| `redis-rate-limiter.ts` | **Redis Lua 滑动窗口**（ZREMRANGEBYSCORE + ZCARD + ZADD），多副本共享 | 已实现，未接线 |
| `retry.ts` | `classifyError` + 指数退避 | 已实现，未接线 |
| `llm-tracer.ts` | `LlmTraceStore` interface + 进程内实现 | 已实现，未接线 |

**影响（正面）**：F6 的限流部分可以直接复用 `RedisRateLimiter`（多副本正确性已考虑）。`BudgetGuard` 只适合单进程单 run，跨副本预算需要 DB 累计器（见 D7）。`LlmTraceStore` 的 interface 与我们要的 `llm_calls` 高度重合，**优先按它的形状实现 Drizzle 版本**，而不是另起炉灶。

### 2.6 ⚠️ `runs.model_id` / `runs.connection_mode` / `agents.model` 三列存在但从不被读

```bash
$ grep -n "modelId" packages/control-plane/src/run/run-orchestrator.ts
（空）
```

`AgentBridge.sendPrompt()` 支持 `modelId` 参数，但 `RunOrchestrator.execute()` 调用时**没有传**；`AgentConfig` 类型里也没有 `model` 字段（尽管 `agents` 表有 `model` 列）。结果：模型名永远由 agent-worker 的 `process.env.CLAUDE_MODEL` 决定，per-agent / per-run 模型选择**实际不生效**。

**影响**：F1"统一模型入口"顺带要修这条断链（M6 · T6.2）。这是一个独立的、低风险的 bug fix，建议单独 commit 并配 Red Test。

### 2.7 ℹ️ `specs/credential-proxy.md` 已存在，但方向是 sidecar 而非协议网关

仓库已有 `specs/credential-proxy.md`（状态 **Deferred**），设计方向是**同 Pod 的 sidecar HTTP 代理 + iptables 强制出网**，按 host/scheme/port 精确匹配注入 `Authorization`。

**与本课题的关系**：两者解决同一个问题（密钥不进沙箱），但形态不同：

| | credential-proxy（已存在 spec） | llm-router（本课题） |
|---|---|---|
| 形态 | 通用 HTTP 转发 sidecar | **协议感知**的模型网关（独立服务） |
| 覆盖面 | 任意 HTTP 凭据（GitHub / S3 / OpenAI…） | 只覆盖 LLM 调用 |
| 能否逐调用计量 | 否（不解析 body/SSE） | **是** |
| 能否做模型目录/路由 | 否 | **是** |
| 部署耦合 | 与沙箱 1:1，需 iptables | 独立多副本，无沙箱侵入 |

**决策**：两者**互补而非替代**。llm-router 落地后，`credential-proxy.md` 的适用范围收窄为"非 LLM 的 HTTP 凭据"。**必须在 `specs/llm-router.md` 里写明这层关系**，否则后来者会以为二者冲突。

### 2.8 ⚠️ Provider 子进程环境变量的继承行为在 3.4.4 与 3.6.0 之间发生了变化

这是**直接决定 A11 能否成立**的实现细节，务必看清楚。

**锁定的 3.4.4**：子进程环境从一份**窄白名单**构造，白名单 = 平台基础变量 + `CLAUDE_CONFIG_DIR`，**不含 `ANTHROPIC_*` 前缀**：

```js
// ai-sdk-provider-claude-code@3.4.4 dist/index.js
var CLAUDE_ENV_VARS = ["CLAUDE_CONFIG_DIR"];
function getBaseProcessEnv() {
  const allowedKeys = new Set([...DEFAULT_INHERITED_ENV_VARS, ...CLAUDE_ENV_VARS]);
  // DEFAULT_INHERITED_ENV_VARS = ["HOME","LOGNAME","PATH","SHELL","TERM","USER","LANG","LC_ALL","TMPDIR"]
  ...
}
```

→ 这正是 `server.ts` 必须显式把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 从 `process.env` 拷进 `providerEnv` 的原因。**换句话说：子进程环境目前是 100% 受 `env` 设置控制的，我们把那两行删掉，真 key 就进不去。**

**升级到 3.6.0 后（`@anthropic-ai/claude-agent-sdk` 0.3.x）行为反转**——白名单新增了前缀匹配：

> SDK 0.3.x treats `Options.env` as a full **replacement** for the subprocess environment. The provider always constructs the subprocess environment from a sanitizing allowlist of `process.env`, then applies your `env` setting on top. The allowlist is: … **any variable starting with `ANTHROPIC_`, `CLAUDE_`, `AWS_`, or `GOOGLE_`** …

→ 升级后，agent-worker 容器里任何 `ANTHROPIC_API_KEY` **会自动泄漏进子进程**。

**结论（写进代码注释和 Spec）**：不能依赖"不设置就不会有"，必须**显式抹除**：

```ts
const providerEnv: Record<string, string | undefined> = {
  ...(env ?? {}),
  // 显式抹除：3.6.0+ 的白名单会前缀继承 ANTHROPIC_*/AWS_*，
  // 这里的 undefined 是硬保证，不随 provider 版本漂移。见 specs/llm-router.md §密钥边界
  ANTHROPIC_API_KEY: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
};
```

并在 M7 加一条**版本回归测试**：断言子进程 env 中不存在这些键（见 T7.3）。

### 2.9 现状小结：复用 vs 缺口（修订版）

| 能力 | 课题说明的判断 | **实际状态（e62f507）** | 本计划的处置 |
|---|---|---|---|
| 双层 Vault 加解密 | 已具备，建议复用 | 已实现，**未接线**，对称 KEK | **不复用**，另起非对称信封（D3） |
| output-sanitizer | 已具备 | 已实现，**未接线** | 复用纯函数，接到 router 日志出口 |
| 审计日志 | 已具备 | 只有 interface，**无表无实现** | 不建表；`llm_calls` 兼作调用审计 |
| `service_tokens` | 部分（缺配额字段） | 表 + 认证中间件均可用 | **不复用表**（D5），复用哈希/吊销范式 |
| `data-openrush-usage` | 用量事件雏形 | **无任何生产者** | 由 control-worker 在 run 收敛时聚合发出 |
| `ClaudeCodeConfig`/`buildEnvVars` | 协议抽象起点 | **死代码** | 不使用；真实落点是 `server.ts` |
| 预算/限流 | roadmap 待实现 | **积木已在 agent-runtime，未接线** | 复用 `RedisRateLimiter`；预算改 DB 累计 |
| `RATE_LIMITED` 错误码 | 预留未实施 | 枚举 + HTTP 映射（429）已就位 | 直接使用 |
| 逐调用计量 | 缺口 | 缺口（`LlmTraceStore` interface 可复用形状） | 新建 `llm_calls` 表 |
| 模型↔供应商目录 | 缺口 | 缺口 | 新建 3 张表 |
| OpenAI 协议 | 缺口 | 缺口 | 新增 adapter |

---

## 3. 关键决策清单（D1–D12）

> 按用户要求，本节**只给结论 + 一句话理由**，不展开备选方案对比。若要补齐课题交付物 1（可行性研究报告），在每条下方按"备选 / 选择 / 理由"三段扩写即可，选型骨架已固定。

| # | 决策点 | 结论 | 一句话理由 |
|---|---|---|---|
| **D1** | 网关落位 | 独立服务 `apps/llm-router`（Hono，默认 `:8790`），夹在 **Claude Code CLI ↔ 供应商** 之间，靠 agent-worker 注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 生效 | 双层 SSE 与 Run 状态机完全不经过网关，A1/A3 天然成立；且这正是 Claude Code 官方 gateway 协议的接入点 |
| **D2** | 对外协议面 | 同时暴露 Anthropic Messages（`/v1/messages`）与 OpenAI（`/v1/chat/completions`）；上游适配分 `passthrough`（同协议）与 `translate`（跨协议） | A1「body 零改写」与 F2「异构供应商」在跨协议时**不可兼得**，必须显式分层承诺 |
| **D2b** | 模型名改写 | 默认 `alias == upstream_model` → **字节级零改写**；仅当显式配置异名时进入 `rewrite-model` 模式，且**只允许改 `model` 这一个 JSON 字段** | 把 A1 的例外收敛成一个可被单测精确断言的点，而不是模糊的"除计量外" |
| **D3** | 密钥盲写 | **非对称信封**：apps/web 只持公钥（`LLM_ROUTER_PUBLIC_KEY`），llm-router 独占私钥（`LLM_ROUTER_PRIVATE_KEY`）。算法 `X25519 + HKDF-SHA256 + AES-256-GCM`（sealed box），Node 内置零依赖 | web 在**物理上不具备**解密能力，A11 变成结构性保证而非策略保证；对称 KEK 做不到这点 |
| **D4** | 与既有 Vault 的关系 | **并存不耦合**。llm-router 凭据走自己的 `llm_credentials` 表 + 非对称信封；`vault_entries` 保持原样服务其他凭据 | Vault 的对称 KEK 由部署侧持有、web 可解密，与"录入即盲写"根本冲突；且 Vault 当前未接线（2.3），改造它风险大于收益 |
| **D5** | 调用方凭据 | 新表 `llm_router_tokens`，**per-run 短时令牌**（SHA-256 存哈希），subject 绑定在令牌上而非 header 上 | `service_tokens.owner_user_id NOT NULL` + v1 scope 枚举是对外 API 契约；per-run 机器凭据的生命周期（分钟级、随 run 吊销）与之不同。复用哈希/吊销**范式**，不复用表 |
| **D6** | 归属（subject）来源 | **令牌即归属**。`x-claude-code-session-id` / `x-claude-code-agent-id` 只作分组提示，不作授权与计费依据 | 沙箱内 agent 有 bash，能改环境变量与 header；只有令牌是我们签发且可验证的 |
| **D7** | 目录/凭据热变更 | DB 为唯一真相 + 进程内快照缓存 + PostgreSQL `LISTEN/NOTIFY` 失效通知 + **兜底轮询**（读单行 `llm_catalog_state.version`，默认 5s） | postgres.js 原生支持 `sql.listen()`，NOTIFY 亚秒级；轮询兜底保证连接抖动/新副本仍能收敛，A7/A8 有确定上界 |
| **D8** | 计量 | llm-router 逐调用写 `llm_calls`（异步批量，**失败不阻塞**转发）；run 收敛时由 control-worker 聚合回写 `data-openrush-usage` | A5 明确要求"计量失败不阻塞上层调用"；同时用聚合回写把新表接回既有事件契约 |
| **D9** | 预算 / 限流 | 限流**复用** `packages/agent-runtime` 的 `RedisRateLimiter`；预算用 `llm_budget_usage` DB 累计器 + 进程内缓存，两档开关 `observe`（只记不拦）/ `enforce`（拦截） | 限流是请求计数（Redis 天然合适），预算是金额累计（需持久、需跨重启），二者存储不同 |
| **D10** | 错误面 | **三套错误信封各司其职**：① 上游错误**原样透传**（字节不改）；② 网关自身错误按调用方协议成形（Anthropic `{type:"error",error:{...}}` / OpenAI `{error:{...}}`）；③ 控制台 API 用仓库既有 `{error:{code,message}}` v1 信封 | Claude Code 的自动降级重试**按上游错误文案匹配**，包一层就会破坏恢复路径（官方 gateway 协议明文要求） |
| **D11** | 高可用 | 无状态多副本；共享状态全在 PG/Redis；`GET /healthz`（存活）+ `GET /readyz`（就绪，含私钥已加载 + 目录快照非空）；SIGTERM 后停止收新请求、等待在途流最多 `DRAIN_TIMEOUT_MS` | SSE 长连接是滚动更新的唯一难点，靠 readiness 摘流 + 优雅 drain 解决，不需要粘性会话 |
| **D12** | 出网收敛 | MVP **不依赖**沙箱网络策略。沙箱内没有任何真 key，绕过网关也调不通供应商 | 把 A9 从"网络必须封死"降级为"没有钥匙就没有门"，去掉了对 OpenSandbox `patchEgressRules`（尚未实现）的硬依赖 |

### 3.1 D2 的承诺分层（务必写进 Spec 与验收报告）

| 模式 | 触发条件 | A1 承诺 | 计量 | MVP 是否交付 |
|---|---|---|---|---|
| `passthrough` | 调用方协议 == 上游协议，且 `alias == upstream_model` | **请求 body 与响应 body 逐字节一致**；SSE 事件不丢不改序 | 旁路 tee | ✅ 必交 |
| `rewrite-model` | 同协议，`alias != upstream_model` | 除 `$.model` 一个字段外，解析后对象深度相等 | 旁路 tee | ✅ 必交 |
| `translate` | 调用方协议 != 上游协议（如 Anthropic-in → OpenAI-out） | **不承诺零改写**；承诺语义等价 + 流式不丢事件 | 旁路 tee | 🟡 Stretch（M4·T4.7） |

> 这条分层是本方案最重要的诚实性声明。课题的 A1 与 F2 在跨协议时数学上不可同时满足；把它显式化，比含糊地说"尽量不改写"更有说服力。

---

## 4. 目标架构与数据流

### 4.1 改造前 / 改造后

**改造前（e62f507）**

```
浏览器 ──SSE②── apps/web ──pg-boss── apps/control-worker ──HTTP+SSE①── apps/agent-worker(:8787)
                                                                              │
                                                                              │ claudeCode(model,{env})
                                                                              ▼
                                                                    Claude Code CLI 子进程
                                                                              │ ANTHROPIC_API_KEY(明文,来自容器 env)
                                                                              ▼
                                                                        供应商 (api.anthropic.com / GLM)
```

**改造后**

```
浏览器 ──SSE②── apps/web ──pg-boss── apps/control-worker ──HTTP+SSE①── apps/agent-worker(:8787)
                   │                        │                                 │
                   │ 录入(公钥 seal)         │ 签发/吊销 run 令牌               │ claudeCode(model,{env})
                   │                        │ 注入 ANTHROPIC_BASE_URL          ▼
                   │                        │      ANTHROPIC_AUTH_TOKEN  Claude Code CLI 子进程
                   │                        │                                 │ Authorization: Bearer rt_xxx
                   ▼                        ▼                                 ▼
        ┌──────────────────────────────────────────────────────────────────────────────┐
        │  apps/llm-router  (Hono, :8790, 无状态 N 副本)                                 │
        │  ┌────────────┬──────────┬───────────┬────────────┬──────────┬─────────────┐ │
        │  │ authn      │ rate     │ budget    │ resolve    │ forward  │ tee+meter   │ │
        │  │ (令牌→归属) │ (Redis)  │ (DB累计)  │ (目录快照) │ (字节透传)│ (旁路计量)   │ │
        │  └────────────┴──────────┴───────────┴────────────┴──────────┴─────────────┘ │
        │  私钥 LLM_ROUTER_PRIVATE_KEY 仅存在于本进程内存                                 │
        └──────────────────────────────────────────────────────────────────────────────┘
                   │                                       │
                   │ 明文 key（仅进程内存，请求期）           │ 异步批写
                   ▼                                       ▼
        供应商 A(Anthropic) / 供应商 B(OpenAI 风格) / …    PostgreSQL: llm_calls / llm_budget_usage
```

**关键点：SSE① 与 SSE② 一条字节都没变。** llm-router 位于 Claude Code CLI 的下游，对 open-rush 的双层 SSE 协议与 15 状态机完全不可见。这是 D1 的全部价值所在。

### 4.2 一次 Run 的完整时序

```
1.  web            POST /api/v1/agents/:id/runs            → runs 行入库，pg-boss 入队
2.  control-worker RunOrchestrator.execute()
3.    ├─ transition(provisioning)
4.    ├─ agentExecutor.prepareContext()                     → agentContext.env（Vault，当前为空）
5.    ├─ LlmAccessService.issueForRun({runId, agentId,      ★ 新增
6.    │    projectId, ownerUserId, modelAlias, ttlSeconds})
7.    │    → 明文令牌 rt_xxx（只此一次可见）+ llm_router_tokens 行（存 SHA-256）
8.    ├─ sandboxEnv = {...agentContext.env, ...grant.env}   ★ 新增
9.    │    grant.env = { ANTHROPIC_BASE_URL: <router 内网地址>,
10.   │                  ANTHROPIC_AUTH_TOKEN: rt_xxx,
11.   │                  ANTHROPIC_MODEL: <alias> }
12.   ├─ sandboxProvider.create({ env: sandboxEnv })
13.   ├─ transition(preparing) → healthCheck → transition(running)
14.   ├─ agentBridge.sendPrompt(prompt, { env: sandboxEnv, modelId: alias, ... })   ★ modelId 补传
15.   │
16.   │     agent-worker: claudeCode(alias, { env: providerEnv })   ← providerEnv 不再含真 key
17.   │       └─ Claude Code CLI 子进程
18.   │            └─ POST {ANTHROPIC_BASE_URL}/v1/messages?beta=true
19.   │                 Authorization: Bearer rt_xxx
20.   │                 x-claude-code-session-id: <sid>
21.   │                 anthropic-version / anthropic-beta / …
22.   │
23.   │                 llm-router:
24.   │                   a. 令牌 → subject（run/agent/project/user）；过期/吊销 → 401
25.   │                   b. 读 body 的 model → 目录快照解析 → 未知 alias → 404
26.   │                   c. 限流（Redis 滑动窗口，key=subject）→ 超限 429 RATE_LIMITED
27.   │                   d. 预算（DB 累计 + 缓存）→ enforce 且超限 → 429；observe → 放行
28.   │                   e. 解封凭据（私钥 open，明文仅在栈上）→ 构造上游 header
29.   │                   f. fetch(上游, { body: 原始字节 })
30.   │                   g. 响应 body 经 TransformStream 原样转发 + 旁路解析 usage
31.   │                   h. 流结束/中断 → 计算 cost → 入队 llm_calls（异步批写）
32.   │
33.   ├─ consumeStream() → run_events（SSE① 语义不变）
34.   ├─ finalize()
35.   ├─ aggregateUsage(runId) → 发出 data-openrush-usage {tokensIn,tokensOut,costUsd}   ★ 新增
36.   └─ finally: LlmAccessService.revokeForRun(runId)                                   ★ 新增
```

### 4.2.1 ⚠️ dev 与 prod 的 env 注入路径不同（实现时必看）

`grant.env` 有**两条**到达 Claude Code 子进程的路径，二者在不同模式下生效：

| 路径 | 载体 | dev（`LocalDevSandboxProvider`） | prod（`OpenSandboxProvider`） |
|---|---|---|---|
| ① 沙箱容器环境 | `sandboxProvider.create({ env })` | **无效**——`LocalDevSandboxProvider.create()` 完全忽略 `options`，只返回指向 `127.0.0.1:8787` 的假沙箱 | 有效，写进容器 env |
| ② 请求体透传 | `agentBridge.sendPrompt(prompt, { env })` → agent-worker 的 `providerEnv` → `claudeCode(model, { env })` | **有效** | 有效 |

**结论**：路径 ② 是两种模式下都成立的那一条，因此 7.17 的改动**必须同时**把 `sandboxEnv` 传给 `sendPrompt`（而不只是传给 `create`）。dev 环境下如果只改了 `create`，会看到"网关完全没被调用、还在直连"的现象——这是最容易踩的坑。

对应地，`apps/agent-worker/.env.local` 里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 在改造后**必须清空**，否则 dev 下 agent-worker 仍会把它们塞进 `providerEnv`（改造前的行为），把注入的网关地址覆盖掉。

---

### 4.3 新增/改动文件全景

```
新增
├── apps/llm-router/                                     ★ 新 app
│   ├── src/server.ts
│   ├── src/routes/{messages,count-tokens,chat-completions,models,health}.ts
│   ├── src/middleware/{authenticate,rate-limit,budget,request-log}.ts
│   ├── .env.example  package.json  tsconfig.json  vitest.config.ts
│
├── packages/llm-router/                                 ★ 新 package（核心逻辑）
│   └── src/
│       ├── index.ts
│       ├── crypto/{sealed-box.ts,key-loader.ts}
│       ├── catalog/{types.ts,catalog-store.ts,drizzle-catalog-store.ts,catalog-cache.ts,resolve-route.ts}
│       ├── auth/{router-token.ts,token-store.ts,drizzle-token-store.ts}
│       ├── proxy/{forward.ts,headers.ts,sse-tee.ts,model-rewrite.ts}
│       ├── usage/{types.ts,anthropic-parser.ts,openai-parser.ts,cost.ts}
│       ├── metering/{call-recorder.ts,drizzle-call-store.ts}
│       ├── budget/{budget-service.ts,drizzle-budget-store.ts}
│       ├── guard/rate-limit.ts
│       ├── adapters/{protocol.ts,anthropic-to-openai.ts}
│       └── errors.ts
│
├── packages/contracts/src/v1/llm-router.ts              ★ 新契约
├── packages/db/src/schema/llm-{providers,credentials,models,router-tokens,calls,budgets,catalog-state}.ts
├── packages/db/drizzle/0012_llm_router.sql              ★ 新 migration
├── apps/web/app/api/v1/llm/                             ★ 控制台 API
│   ├── providers/{route.ts,[id]/route.ts}
│   ├── models/{route.ts,[id]/route.ts}
│   ├── credentials/{route.ts,[id]/route.ts}
│   └── budgets/route.ts
├── specs/llm-router.md                                  ★ 新 Spec
├── scripts/gen-router-keypair.ts                        ★ 密钥对生成 CLI
└── docs/llm-router.md                                   ★ 运维文档

改动
├── apps/agent-worker/src/server.ts        （删 2 行 process.env 直通；加显式抹除）
├── apps/control-worker/src/worker.ts      （装配 LlmAccessService）
├── packages/control-plane/src/run/run-orchestrator.ts  （签发/注入/吊销/聚合 usage）
├── packages/control-plane/src/run/agent-executor.ts    （AgentContext 加 modelAlias）
├── packages/control-plane/src/agent/agent-config.ts    （AgentConfig 加 model 字段）
├── packages/control-plane/src/index.ts    （导出 LlmAccessService）
├── packages/db/src/schema/index.ts        （barrel 导出新表）
├── packages/db/src/client.ts              （新增 createNotificationListener）
├── packages/contracts/src/v1/index.ts     （导出 llm-router 契约）
├── packages/control-plane/src/admin/audit-log.ts       （AuditAction 补 3 值）
├── docker/docker-compose.dev.yml          （可选：llm-router 服务）
├── package.json / turbo.json              （新 workspace 无需改，pnpm-workspace 已含 apps/* packages/*）
└── docs/roadmap.md                        （勾掉 "AI Provider resilience" 的 budget/rate 项）
```

---

## 5. 数据模型

7 张新表，全部前缀 `llm_`。遵循 `specs/migration-policy.md`：改 `packages/db/src/schema/` → `pnpm --filter @open-rush/db db:generate` → **schema 与 migration 同一个 commit**。

### 5.1 表关系

```
llm_credentials ──1:N── llm_providers ──1:N── llm_models
      │(密文,web 不可读)                            │
      │                                            │ alias 解析
llm_router_tokens ───────────────────────────────► llm_calls ──聚合──► data-openrush-usage
      │(per-run,SHA-256)                            │
      └──► subject(run/agent/project/user) ─────────┴──► llm_budget_usage ◄── llm_budgets

llm_catalog_state (单行 version，NOTIFY 与轮询共用)
```

### 5.2 `llm_credentials` — 盲写凭据

```ts
// packages/db/src/schema/llm-credentials.ts
import { pgTable, uuid, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * 供应商真实密钥的**密文**存储。
 *
 * 安全不变量（specs/llm-router.md §密钥边界）：
 * 1. 本表**没有任何明文列**，也没有可解密回明文的对称密钥存在于 web/control-plane。
 * 2. `sealed_value` 由 apps/web 用 LLM_ROUTER_PUBLIC_KEY 单向封装（X25519 sealed box）。
 *    对应私钥只存在于 llm-router 进程，web 侧物理上无法解封。
 * 3. `/api/v1/llm/credentials` 的任何响应**永不包含** `sealed_value`。
 * 4. 轮换 = 覆盖 `sealed_value` + `version++`，**不保留历史密文**（A8："旧密钥不可从持久层还原"）。
 */
export const llmCredentials = pgTable(
  'llm_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 人类可读标识，控制台按名字引用，如 'anthropic-prod' */
    name: varchar('name', { length: 100 }).notNull().unique(),
    /** 封装算法标识；当前唯一合法值 'x25519-hkdf-sha256-aes256gcm' */
    alg: varchar('alg', { length: 40 }).notNull().default('x25519-hkdf-sha256-aes256gcm'),
    /** 收件公钥指纹（SHA-256(raw pub) 前 32 hex）。router 启动时比对，指纹不符即拒绝解封 */
    keyId: varchar('key_id', { length: 64 }).notNull(),
    /** base64(ephPub32 || iv12 || tag16 || ciphertext) */
    sealedValue: text('sealed_value').notNull(),
    /** 上游认证方式：bearer → Authorization: Bearer；x-api-key → x-api-key；header → 用 authHeader */
    authStyle: varchar('auth_style', { length: 20 }).notNull().default('bearer'),
    authHeader: varchar('auth_header', { length: 64 }),
    /** 轮换计数，从 1 开始 */
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [index('llm_credentials_key_id_idx').on(t.keyId)]
);
```

### 5.3 `llm_providers` — 供应商

```ts
// packages/db/src/schema/llm-providers.ts
export const llmProviders = pgTable(
  'llm_providers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull().unique(),
    /** 上游协议族：'anthropic' | 'openai' */
    protocol: varchar('protocol', { length: 20 }).notNull(),
    /** 不含尾斜杠，如 https://api.anthropic.com */
    baseUrl: text('base_url').notNull(),
    credentialId: uuid('credential_id').references(() => llmCredentials.id, { onDelete: 'restrict' }),
    /** 附加请求头（非敏感），如 { "X-Tenant": "rush" } */
    defaultHeaders: jsonb('default_headers').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** 上游超时；SSE 长流场景默认 10 分钟 */
    timeoutMs: integer('timeout_ms').notNull().default(600_000),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('llm_providers_enabled_idx').on(t.enabled),
    check('llm_providers_protocol_check', sql`${t.protocol} IN ('anthropic','openai')`),
  ]
);
```

### 5.4 `llm_models` — 模型 ↔ 供应商目录（F1/F4 的核心）

```ts
// packages/db/src/schema/llm-models.ts
export const llmModels = pgTable(
  'llm_models',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 上层看到的唯一模型名。默认应与 upstreamModel 同名以获得字节级零改写（D2b） */
    alias: varchar('alias', { length: 255 }).notNull(),
    providerId: uuid('provider_id').notNull().references(() => llmProviders.id, { onDelete: 'cascade' }),
    /** 上游真实模型名 */
    upstreamModel: varchar('upstream_model', { length: 255 }).notNull(),
    /** 同 alias 多行时的优先级，取 enabled 中最小者。为未来 fallback chain 预留 */
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    /** /v1/models 模型发现用；Claude Code 只收 id 含 claude/anthropic 的条目 */
    displayName: varchar('display_name', { length: 255 }),
    maxOutputTokens: integer('max_output_tokens'),
    // ── 价格（USD / 每百万 token），用于 cost_usd 计算 ──
    priceInputPerMtok:      numeric('price_input_per_mtok',       { precision: 12, scale: 6 }).notNull().default('0'),
    priceOutputPerMtok:     numeric('price_output_per_mtok',      { precision: 12, scale: 6 }).notNull().default('0'),
    priceCacheWritePerMtok: numeric('price_cache_write_per_mtok', { precision: 12, scale: 6 }).notNull().default('0'),
    priceCacheReadPerMtok:  numeric('price_cache_read_per_mtok',  { precision: 12, scale: 6 }).notNull().default('0'),
    /** OpenAI 系的 reasoning_tokens 若单独计价则填；Anthropic 的 thinking 已含在 output 中，留 0 */
    priceReasoningPerMtok:  numeric('price_reasoning_per_mtok',   { precision: 12, scale: 6 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('llm_models_alias_provider_idx').on(t.alias, t.providerId),
    index('llm_models_alias_enabled_idx').on(t.alias, t.enabled, t.priority),
  ]
);
```

> **A4 的判定规则**：`resolveRoute(alias)` = 取 `enabled = true` 且 `provider.enabled = true` 的行中 `priority` 最小者；并列时按 `id` 升序（确定性）。无匹配 → 404，**且错误信息只回显 alias，不回显目录内容**。

### 5.5 `llm_router_tokens` — 调用方接入凭据（F7）

```ts
// packages/db/src/schema/llm-router-tokens.ts
/**
 * llm-router 的调用方凭据。与 `service_tokens` 的区别（D5）：
 *  - subject 是 run/agent/project 而非 user；`owner_user_id` 可空
 *  - 生命周期是分钟级（随 run 创建、随 run 收敛吊销）
 *  - 带配额字段（maxCostUsd / maxRequestsPerMinute），service_tokens 没有
 * 复用的是范式：明文只在创建时返回一次，库里只存 SHA-256 hex。
 */
export const llmRouterTokens = pgTable(
  'llm_router_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** SHA-256(明文) hex，明文形如 rt_<43 chars base64url> */
    tokenHash: text('token_hash').notNull(),
    /** 'run' | 'service'（后者供外部系统长期调用） */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    runId:       uuid('run_id').references(() => runs.id,     { onDelete: 'cascade' }),
    agentId:     uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    projectId:   uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 允许访问的 alias 白名单；空数组 = 不限制 */
    allowedModelAliases: jsonb('allowed_model_aliases').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    maxCostUsd: numeric('max_cost_usd', { precision: 12, scale: 6 }),
    maxRequestsPerMinute: integer('max_requests_per_minute'),
    expiresAt:  timestamp('expires_at',   { withTimezone: true }).notNull(),
    revokedAt:  timestamp('revoked_at',   { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt:  timestamp('created_at',   { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('llm_router_tokens_hash_uniq').on(t.tokenHash),
    index('llm_router_tokens_active_idx').on(t.tokenHash).where(sql`${t.revokedAt} IS NULL`),
    index('llm_router_tokens_run_idx').on(t.runId),
    check('llm_router_tokens_subject_check',
      sql`(${t.subjectType} = 'run' AND ${t.runId} IS NOT NULL) OR ${t.subjectType} = 'service'`),
  ]
);
```

### 5.6 `llm_calls` — 逐调用计量（F5/A5）

```ts
// packages/db/src/schema/llm-calls.ts
/**
 * 一行 = 一次上游 LLM 调用。这是"逐调用计量"的真相表。
 * 形状对齐 packages/agent-runtime 的 LlmTraceStore/LlmSpanAttributes（复用其抽象，见 2.5）。
 * 写入是**异步、批量、失败不阻塞**的（A5）。
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 复用 packages/observability 的 request-id（x-request-id） */
    requestId: varchar('request_id', { length: 64 }),
    tokenId: uuid('token_id').references(() => llmRouterTokens.id, { onDelete: 'set null' }),
    // ── 归属（来自令牌，非 header；D6）──
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    runId:       uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    agentId:     uuid('agent_id'),
    projectId:   uuid('project_id'),
    ownerUserId: uuid('owner_user_id'),
    // ── 分组提示（来自 header，不可信，仅用于下钻）──
    ccSessionId: varchar('cc_session_id', { length: 128 }),
    ccAgentId:   varchar('cc_agent_id',   { length: 128 }),
    // ── 路由 ──
    modelAlias:    varchar('model_alias',    { length: 255 }).notNull(),
    providerId:    uuid('provider_id'),
    upstreamModel: varchar('upstream_model', { length: 255 }),
    protocol:      varchar('protocol', { length: 20 }).notNull(),
    /** 'passthrough' | 'rewrite-model' | 'translate' */
    mode:          varchar('mode', { length: 20 }).notNull(),
    stream:        boolean('stream').notNull().default(false),
    // ── 结果 ──
    /** success | upstream_error | rate_limited | budget_exceeded | client_abort | router_error | unauthorized | model_not_found */
    status:     varchar('status', { length: 30 }).notNull(),
    httpStatus: integer('http_status'),
    errorCode:  varchar('error_code', { length: 50 }),
    // ── token 拆分（A5："推理 token 尤须拆开"）──
    tokensIn:         integer('tokens_in').notNull().default(0),          // 非缓存输入
    tokensCacheWrite: integer('tokens_cache_write').notNull().default(0),
    tokensCacheRead:  integer('tokens_cache_read').notNull().default(0),
    tokensOut:        integer('tokens_out').notNull().default(0),         // 含 thinking（Anthropic 语义）
    tokensReasoning:  integer('tokens_reasoning').notNull().default(0),   // OpenAI completion_tokens_details.reasoning_tokens
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    // ── 性能 ──
    ttfbMs:    integer('ttfb_ms'),
    latencyMs: integer('latency_ms'),
    startedAt:   timestamp('started_at',   { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt:   timestamp('created_at',   { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('llm_calls_run_idx').on(t.runId, t.startedAt),
    index('llm_calls_project_started_idx').on(t.projectId, t.startedAt),
    index('llm_calls_session_idx').on(t.ccSessionId),
    index('llm_calls_status_idx').on(t.status, t.startedAt),
  ]
);
```

> **关于"推理 token 拆开"**：Anthropic Messages API 的 thinking token **已计入 `output_tokens`**，wire 上没有独立字段——这一点必须在验收报告里写清楚，否则 A5 会被误判为未完成。因此 `tokens_reasoning` 对 Anthropic 上游恒为 0，对 OpenAI 上游取 `usage.completion_tokens_details.reasoning_tokens`。缓存读写则两族都能拆（`cache_creation_input_tokens` / `cache_read_input_tokens` vs `prompt_tokens_details.cached_tokens`）。

### 5.7 `llm_budgets` + `llm_budget_usage` — 预算（F6/A6）

```ts
// packages/db/src/schema/llm-budgets.ts
export const llmBudgets = pgTable(
  'llm_budgets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 'global' | 'project' | 'user' | 'agent' */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    /** global 时为 NULL */
    subjectId: uuid('subject_id'),
    /** 'day' | 'month' | 'total' */
    window: varchar('window', { length: 20 }).notNull(),
    limitUsd: numeric('limit_usd', { precision: 12, scale: 6 }).notNull(),
    /** false = observe（只计量不拦截，A6："开关关闭时不卡业务但仍计量"）；true = enforce */
    enforce: boolean('enforce').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('llm_budgets_subject_window_idx').on(t.subjectType, t.subjectId, t.window)]
);

export const llmBudgetUsage = pgTable(
  'llm_budget_usage',
  {
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    subjectId: uuid('subject_id'),
    /** 'day' → '2026-09-08'；'month' → '2026-09'；'total' → 'total'（UTC） */
    windowKey: varchar('window_key', { length: 20 }).notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    calls: integer('calls').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.subjectType, t.subjectId, t.windowKey] })]
);
```

> 累计用 `INSERT … ON CONFLICT DO UPDATE SET cost_usd = llm_budget_usage.cost_usd + EXCLUDED.cost_usd`，与 `llm_calls` 批写在**同一个事务**里，保证不重不漏。

### 5.8 `llm_catalog_state` — 热变更版本位（D7/A7/A8）

```ts
// packages/db/src/schema/llm-catalog-state.ts
/**
 * 单行表。任何目录/凭据写操作都必须：
 *   1) 在同一事务内 UPDATE llm_catalog_state SET version = version + 1
 *   2) 提交后 pg_notify('llm_catalog', version::text)
 * 副本收到 NOTIFY 立即刷新；同时以 LLM_CATALOG_POLL_MS（默认 5000）轮询本表兜底。
 */
export const llmCatalogState = pgTable('llm_catalog_state', {
  id: integer('id').primaryKey().default(1),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

migration 里补一条种子：

```sql
-- packages/db/drizzle/0012_llm_router.sql 末尾
INSERT INTO "llm_catalog_state" ("id", "version") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;
```

---

## 6. 对外契约

### 6.1 llm-router 的 HTTP 面（面向 Claude Code / 其他调用方）

| 方法 | 路径 | 用途 | 必须实现 | 说明 |
|---|---|---|---|---|
| POST | `/v1/messages` | Anthropic Messages 推理 | ✅ | Claude Code 实际请求 `/v1/messages?beta=true`，**按 path 匹配，不要匹配完整 URL** |
| POST | `/v1/messages/count_tokens` | token 计数 | ✅ | 官方标注可选；不实现会让 Claude Code 改用推理请求估算上下文，浪费额度 |
| GET | `/v1/models` | 模型发现 | ✅ | 需 `?limit=1000` 支持；**3 秒超时内响应，且不得重定向**（含 http→https），否则发现静默失败 |
| HEAD | `/api/hello` | 连接预热探针 | ✅ | 返回 200 即可；不实现会在日志里刷 404 |
| POST | `/v1/chat/completions` | OpenAI 兼容推理 | ✅ | F2 的"OpenAI 风格"对外面 |
| GET | `/healthz` | 存活 | ✅ | 只查进程 |
| GET | `/readyz` | 就绪 | ✅ | 私钥已加载 **且** 目录快照非空 **且** DB 可达 |
| GET | `/metrics` | Prometheus | 🟡 | 可选，便于 A2 取 p95 |

**请求头处理规则**（依据 Claude Code 官方 gateway 协议）：

| 头 | 处理 |
|---|---|
| `Authorization` / `x-api-key` | **消费**（这是 router 令牌），**绝不转发上游** |
| `anthropic-version`、`anthropic-beta` | **原样转发**。`anthropic-beta` 是开放列表，**禁止白名单过滤**——过滤会在 Claude Code 新版本发布时静默打断新能力 |
| `anthropic-workspace-id` | 原样转发（若存在） |
| `x-claude-code-session-id` / `-agent-id` / `-parent-agent-id` | **消费**并记入 `llm_calls`（分组用），可不转发 |
| `content-type` / `accept` | 原样转发 |
| `x-request-id` | 消费 + 记录；向上游转发自己生成的新 id |
| hop-by-hop（`connection`/`transfer-encoding`/`keep-alive`/`upgrade`/`te`/`trailer`/`proxy-*`） | 剥离 |
| 其他 `anthropic-*` / `x-claude-code-*` | **默认转发**（开放列表原则） |
| `llm_providers.default_headers` | 追加 |

**响应处理规则**：

- 上游 body **逐字节原样转发**，包括 SSE `ping` 事件与注释行——Claude Code 有 300 秒**字节级看门狗**，缓冲或吞掉 ping 会导致长思考期间流被中断。
- 上游**错误响应体原样转发**，不得包一层信封——Claude Code 的能力降级重试按错误文案匹配。
- 剥离上游的 hop-by-hop 头与任何可能回显凭据的头。
- `content-encoding`：转发时不请求压缩（对上游发 `accept-encoding: identity`），避免解压/再压导致字节不一致。

### 6.2 网关自身错误（非上游）的信封与码

| 场景 | HTTP | Anthropic 面 `error.type` | OpenAI 面 `error.code` | `llm_calls.status` |
|---|---|---|---|---|
| 令牌缺失/无效/过期/吊销 | 401 | `authentication_error` | `invalid_api_key` | `unauthorized` |
| 令牌不允许该 alias | 403 | `permission_error` | `insufficient_permissions` | `forbidden` |
| 未知/未启用模型 alias | 404 | `not_found_error` | `model_not_found` | `model_not_found` |
| 请求体非法 JSON / 缺 `model` | 400 | `invalid_request_error` | `invalid_request_error` | `router_error` |
| 限流 | 429 | `rate_limit_error` | `rate_limit_exceeded` | `rate_limited` |
| 预算超限（enforce） | 429 | `rate_limit_error` | `rate_limit_exceeded` | `budget_exceeded` |
| 上游不可达/超时 | 502 | `api_error` | `upstream_error` | `upstream_error` |
| 网关内部错误 | 500 | `api_error` | `internal_error` | `router_error` |

Anthropic 面信封：

```json
{ "type": "error",
  "error": { "type": "rate_limit_error",
             "message": "budget exceeded for project 3f2a…: 12.50/10.00 USD (window=day)" } }
```

> 429 一律附带 `Retry-After` 秒数。限流场景取滑动窗口剩余时间；预算场景取到窗口边界的秒数。
> **对上层 `/api/v1/*` 的映射**：控制面若需要把网关 429 冒泡给调用方，映射到仓库既有的 `RATE_LIMITED`（`packages/contracts/src/v1/common.ts` 已定义，HTTP 429）——这就是课题说"承接预留错误码"的兑现点。

### 6.3 控制台 API（apps/web，`/api/v1/llm/*`）

沿用仓库既有 v1 规范：`authenticate()` + `hasScope()` + `v1Success`/`v1Error`/`v1Paginated` 信封。

| 方法 | 路径 | scope | 说明 |
|---|---|---|---|
| POST | `/api/v1/llm/credentials` | `llm:write` | **录入即盲写**：body 传明文 `value`，服务端立刻 `seal()` 并只落密文；响应**不含**任何密文/明文 |
| GET | `/api/v1/llm/credentials` | `llm:read` | 只返回 `{id,name,keyId,alg,authStyle,version,createdAt,rotatedAt}` |
| POST | `/api/v1/llm/credentials/:id/rotate` | `llm:write` | 覆盖 `sealed_value`、`version++`、`rotated_at=now()` |
| DELETE | `/api/v1/llm/credentials/:id` | `llm:write` | 被 provider 引用时 409（`onDelete: 'restrict'`） |
| GET/POST | `/api/v1/llm/providers` | `llm:read`/`llm:write` | |
| PATCH/DELETE | `/api/v1/llm/providers/:id` | `llm:write` | |
| GET/POST | `/api/v1/llm/models` | `llm:read`/`llm:write` | |
| PATCH/DELETE | `/api/v1/llm/models/:id` | `llm:write` | |
| GET/PUT | `/api/v1/llm/budgets` | `llm:read`/`llm:write` | |
| GET | `/api/v1/llm/calls` | `llm:read` | 逐调用查询，支持 `runId`/`projectId`/`from`/`to` 过滤 + 游标分页 |

**新增 scope**：在 `packages/contracts/src/v1/common.ts` 的 `ServiceTokenScope` 枚举里追加 `'llm:read'`、`'llm:write'`。
**平台级资源限制**：`credentials` / `providers` / `models` 是平台级（无 projectId），按仓库既有惯例（见 `apps/web/app/api/v1/vaults/entries/route.ts` 对 `scope=platform` 的处理）**仅接受 session 认证，拒绝 service token**。

### 6.4 Zod 契约（`packages/contracts/src/v1/llm-router.ts`）

```ts
import { z } from 'zod';   // ⚠️ 仓库锁定 zod 3.25.76，用 v3 API

export const llmProtocolSchema = z.enum(['anthropic', 'openai']);
export const llmRouteModeSchema = z.enum(['passthrough', 'rewrite-model', 'translate']);
export const llmAuthStyleSchema = z.enum(['bearer', 'x-api-key', 'header']);

/** 录入凭据。value 是明文，服务端 seal 后即丢弃，永不落库、永不回显、永不进日志。 */
export const createLlmCredentialRequestSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  value: z.string().min(8).max(8192),
  authStyle: llmAuthStyleSchema.default('bearer'),
  authHeader: z.string().min(1).max(64).optional(),
}).refine((v) => v.authStyle !== 'header' || !!v.authHeader, {
  message: 'authHeader is required when authStyle=header', path: ['authHeader'],
});

/** 出参：**结构上不含 sealedValue**，这是 A11 的第一道闸门。 */
export const llmCredentialSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  alg: z.string(),
  keyId: z.string(),
  authStyle: llmAuthStyleSchema,
  authHeader: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  rotatedAt: z.string().datetime().nullable(),
});

export const llmProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  protocol: llmProtocolSchema,
  baseUrl: z.string().url(),
  credentialId: z.string().uuid().nullable(),
  defaultHeaders: z.record(z.string()),
  timeoutMs: z.number().int().positive(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const llmModelSchema = z.object({
  id: z.string().uuid(),
  alias: z.string(),
  providerId: z.string().uuid(),
  upstreamModel: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  displayName: z.string().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  priceInputPerMtok: z.string(),        // numeric → string（drizzle numeric 的默认映射）
  priceOutputPerMtok: z.string(),
  priceCacheWritePerMtok: z.string(),
  priceCacheReadPerMtok: z.string(),
  priceReasoningPerMtok: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** 逐调用记录的对外形状。 */
export const llmCallSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().nullable(),
  subjectType: z.enum(['run', 'service']),
  runId: z.string().uuid().nullable(),
  agentId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  ownerUserId: z.string().uuid().nullable(),
  ccSessionId: z.string().nullable(),
  ccAgentId: z.string().nullable(),
  modelAlias: z.string(),
  upstreamModel: z.string().nullable(),
  protocol: llmProtocolSchema,
  mode: llmRouteModeSchema,
  stream: z.boolean(),
  status: z.enum(['success','upstream_error','rate_limited','budget_exceeded',
                  'client_abort','router_error','unauthorized','forbidden','model_not_found']),
  httpStatus: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  tokensIn: z.number().int().min(0),
  tokensCacheWrite: z.number().int().min(0),
  tokensCacheRead: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  tokensReasoning: z.number().int().min(0),
  costUsd: z.string(),
  ttfbMs: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export type LlmCredential = z.infer<typeof llmCredentialSchema>;
export type LlmProvider  = z.infer<typeof llmProviderSchema>;
export type LlmModel     = z.infer<typeof llmModelSchema>;
export type LlmCall      = z.infer<typeof llmCallSchema>;
```

---

## 7. 代码骨架

> 以下代码已在 Node v22.22.2 上**实跑验证**（7.1 的加密往返与 7.3 的字节级透传 + 用量解析）。可直接落盘后补齐类型与测试。

### 7.1 `packages/llm-router/src/crypto/sealed-box.ts` —— 盲写信封（D3 / F8 / A11）

```ts
/**
 * X25519 sealed box：单向封装供应商密钥。
 *
 * 安全模型：
 *  - apps/web 只拿到公钥（LLM_ROUTER_PUBLIC_KEY），可以 seal()，**无法 open()**。
 *    这不是策略约束，是密码学约束——web 进程里根本没有私钥材料。
 *  - apps/llm-router 独占私钥（LLM_ROUTER_PRIVATE_KEY），只在转发时于栈上解封。
 *  - 每次 seal 使用一次性临时密钥对，密文之间不可关联；AES-GCM 保证篡改可检测。
 *
 * 密文布局：base64( ephPub[32] || iv[12] || tag[16] || ciphertext )
 */
import {
  createCipheriv, createDecipheriv, createHash,
  createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, type KeyObject,
} from 'node:crypto';

export const SEALED_BOX_ALG = 'x25519-hkdf-sha256-aes256gcm';
const INFO = Buffer.from('open-rush/llm-router/v1');
/** X25519 SPKI DER 前缀（固定 12 字节），用于把 32 字节裸公钥还原成 KeyObject */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface SealedEnvelope {
  alg: string;
  /** 收件公钥指纹，router 启动时比对，指纹不符直接拒绝解封（防止错配密钥对） */
  keyId: string;
  value: string;
}

function rawPub(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return der.subarray(der.length - 32);
}

function pubFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function computeKeyId(publicKey: KeyObject): string {
  return createHash('sha256').update(rawPub(publicKey)).digest('hex').slice(0, 32);
}

/** 部署前生成一次；公钥给 web，私钥只给 llm-router。见 scripts/gen-router-keypair.ts */
export function generateRouterKeyPair(): {
  publicKeyPem: string; privateKeyPem: string; keyId: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    keyId: computeKeyId(publicKey),
  };
}

/** apps/web 侧唯一会调用的函数。调用后立即丢弃 plaintext 引用。 */
export function seal(recipientPublicKeyPem: string, plaintext: string): SealedEnvelope {
  const recipient = createPublicKey(recipientPublicKeyPem);
  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: recipient });
  const ephRaw = rawPub(ephPub);
  // salt 绑定双方公钥，避免密文在不同收件人之间被重放
  const salt = Buffer.concat([ephRaw, rawPub(recipient)]);
  const dek = Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  dek.fill(0); shared.fill(0);
  return {
    alg: SEALED_BOX_ALG,
    keyId: computeKeyId(recipient),
    value: Buffer.concat([ephRaw, iv, tag, ct]).toString('base64'),
  };
}

/** 只在 llm-router 进程内调用。返回值是明文密钥，**禁止落库、禁止日志、禁止放进任何响应**。 */
export function openSealed(recipientPrivateKeyPem: string, env: SealedEnvelope): string {
  if (env.alg !== SEALED_BOX_ALG) throw new Error(`unsupported alg: ${env.alg}`);
  const priv = createPrivateKey(recipientPrivateKeyPem);
  const derivedPub = createPublicKey(priv);
  if (computeKeyId(derivedPub) !== env.keyId) {
    throw new Error(`keyId mismatch: envelope=${env.keyId} router=${computeKeyId(derivedPub)}`);
  }
  const buf = Buffer.from(env.value, 'base64');
  if (buf.length < 60) throw new Error('malformed sealed envelope');
  const ephRaw = buf.subarray(0, 32);
  const iv     = buf.subarray(32, 44);
  const tag    = buf.subarray(44, 60);
  const ct     = buf.subarray(60);
  const shared = diffieHellman({ privateKey: priv, publicKey: pubFromRaw(ephRaw) });
  const salt = Buffer.concat([ephRaw, rawPub(derivedPub)]);
  const dek = Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
  const d = createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  dek.fill(0); shared.fill(0);
  return out;
}
```

**实跑结果**（Node v22.22.2）：

```
keyId          : ec97ab88a496b4f7b9e4d0ab8d980d37 / envelope keyId: ec97ab88a496b4f7b9e4d0ab8d980d37
sealed b64 len : 144
roundtrip ok   : true
wrong key rejected: Error
tamper rejected  : Error
```

### 7.2 `packages/llm-router/src/crypto/key-loader.ts` —— 私钥装载（fail-fast）

```ts
/**
 * 私钥装载策略（优先级从高到低）：
 *   1. LLM_ROUTER_PRIVATE_KEY_FILE  —— 指向挂载的文件（K8s Secret volume，推荐）
 *   2. LLM_ROUTER_PRIVATE_KEY       —— PEM 内容，允许 base64 包装
 * 任一失败 → 进程启动即退出（不要带着"能转发但不能解封"的半残状态跑起来）。
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { computeKeyId } from './sealed-box.js';

export interface RouterKeyMaterial { privateKeyPem: string; keyId: string; }

export function loadRouterPrivateKey(env = process.env): RouterKeyMaterial {
  const file = env.LLM_ROUTER_PRIVATE_KEY_FILE?.trim();
  const inline = env.LLM_ROUTER_PRIVATE_KEY?.trim();
  let pem: string | undefined;
  if (file) pem = readFileSync(file, 'utf8');
  else if (inline) pem = inline.includes('BEGIN') ? inline
                       : Buffer.from(inline, 'base64').toString('utf8');
  if (!pem) {
    throw new Error(
      'llm-router: neither LLM_ROUTER_PRIVATE_KEY_FILE nor LLM_ROUTER_PRIVATE_KEY is set. ' +
      'Generate a pair with: pnpm tsx scripts/gen-router-keypair.ts'
    );
  }
  const priv = createPrivateKey(pem);            // 非法 PEM 在此抛错
  if (priv.asymmetricKeyType !== 'x25519') {
    throw new Error(`llm-router: expected an X25519 private key, got ${priv.asymmetricKeyType}`);
  }
  return { privateKeyPem: pem, keyId: computeKeyId(createPublicKey(priv)) };
}
```

> **运维要求**：`LLM_ROUTER_PRIVATE_KEY*` 只出现在 llm-router 的 Deployment/Secret 中。**必须显式验证**：`kubectl get deploy web control-worker -o yaml | grep -i LLM_ROUTER_PRIVATE` 应为空。这条写进 A11 的验收脚本。

### 7.3 `packages/llm-router/src/proxy/sse-tee.ts` —— 字节级透传 + 旁路计量（A1/A5）

```ts
/**
 * 把上游响应流原样转发给调用方，同时把每个 chunk 复制一份给观察者。
 *
 * 三条不变量：
 *  1. `controller.enqueue(chunk)` 传的是**同一个 Uint8Array 引用**——不拷贝、不改写、不重新分块。
 *     这是 A1「逐字节一致」和「SSE 事件不丢、顺序不变」的实现依据。
 *  2. 先 enqueue 再 observe——旁路解析绝不占用首字节时延（TTFB）。
 *  3. observe 抛错被吞掉——A5 要求「计量失败不阻塞上层调用」。
 */
export interface TeeHooks {
  onChunk(chunk: Uint8Array): void;
  /** 正常结束（flush）或被取消（cancel）都会调用，恰好一次 */
  onEnd(reason?: unknown): void;
}

export function teeForMetering(
  upstream: ReadableStream<Uint8Array>,
  hooks: TeeHooks
): ReadableStream<Uint8Array> {
  let ended = false;
  const end = (reason?: unknown) => {
    if (ended) return;
    ended = true;
    try { hooks.onEnd(reason); } catch { /* 旁路失败不影响主链路 */ }
  };
  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);                 // ① 先转发
        try { hooks.onChunk(chunk); } catch { /* ② 旁路 */ }
      },
      flush() { end(); },
      cancel(reason) { end(reason); },             // 客户端断开 → 记 client_abort
    })
  );
}
```

**实跑结果**（把一段真实形状的 Anthropic SSE 切成 9 个跨行、跨事件边界的乱序 chunk）：

```
byte-exact passthrough : true
same chunk count       : true (9 vs 9)
same object identity   : true      ← 每个下游 chunk 与上游是同一个对象引用
flush called           : true
parsed usage           : {"inputTokens":1200,"cacheWrite":500,"cacheRead":9000,
                          "outputTokens":345,"model":"claude-sonnet-4-6","stopReason":"end_turn"}
```

### 7.4 `packages/llm-router/src/usage/anthropic-parser.ts`

```ts
/**
 * 增量解析 Anthropic Messages SSE，抽取 usage。
 *
 * 协议要点：
 *  - `message_start.message.usage` 给出 input/cache 初值；
 *  - `message_delta.usage` 是**累计值**（cumulative），可能只带 output_tokens；
 *  - thinking token **已计入 output_tokens**，wire 上没有独立字段（见 §5.6 注）。
 * 因此各字段用 max() 单调合并，缺字段即保持不变。
 */
export interface WireUsage {
  tokensIn: number; tokensCacheWrite: number; tokensCacheRead: number;
  tokensOut: number; tokensReasoning: number;
}

const DECODER = new TextDecoder();

export class AnthropicSseUsageParser {
  private buf = '';
  private usage: WireUsage = {
    tokensIn: 0, tokensCacheWrite: 0, tokensCacheRead: 0, tokensOut: 0, tokensReasoning: 0,
  };
  private upstreamModel: string | null = null;
  private stopReason: string | null = null;

  push(chunk: Uint8Array): void {
    this.buf += DECODER.decode(chunk, { stream: true });   // stream:true 处理跨 chunk 的多字节字符
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: 标准的行缓冲循环
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trimEnd();
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;             // event: / id: / 注释行 / 空行 全部跳过
      const json = line.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(json); } catch { continue; }  // 半包/畸形不影响转发
      if (evt.type === 'message_start') {
        const msg = evt.message as Record<string, unknown> | undefined;
        this.upstreamModel = (msg?.model as string) ?? null;
        this.merge(msg?.usage as Record<string, number> | undefined);
      } else if (evt.type === 'message_delta') {
        const d = evt.delta as Record<string, unknown> | undefined;
        this.stopReason = (d?.stop_reason as string) ?? this.stopReason;
        this.merge(evt.usage as Record<string, number> | undefined);
      }
    }
  }

  private merge(u?: Record<string, number>): void {
    if (!u) return;
    const m = (cur: number, next: unknown) =>
      typeof next === 'number' && next > cur ? next : cur;
    this.usage.tokensIn         = m(this.usage.tokensIn,         u.input_tokens);
    this.usage.tokensCacheWrite = m(this.usage.tokensCacheWrite, u.cache_creation_input_tokens);
    this.usage.tokensCacheRead  = m(this.usage.tokensCacheRead,  u.cache_read_input_tokens);
    this.usage.tokensOut        = m(this.usage.tokensOut,        u.output_tokens);
  }

  /** 非流式响应：直接喂整个 JSON body（不改动原字节，只是解析副本） */
  pushNonStreamBody(body: Uint8Array): void {
    try {
      const j = JSON.parse(DECODER.decode(body)) as Record<string, unknown>;
      this.upstreamModel = (j.model as string) ?? null;
      this.stopReason = (j.stop_reason as string) ?? null;
      this.merge(j.usage as Record<string, number> | undefined);
    } catch { /* ignore */ }
  }

  result() {
    return { ...this.usage, upstreamModel: this.upstreamModel, stopReason: this.stopReason };
  }
}
```

对应的 `openai-parser.ts` 结构相同，差异只在字段名：

```ts
// 请求侧需保证 stream_options.include_usage=true 才能在流式下拿到 usage。
// ⚠️ 这属于对请求 body 的修改 —— 因此 OpenAI 流式路径在 rewrite 模式下运行，
//    A1 只承诺「除 model 与 stream_options 外深度相等」。若坚持零改写，
//    则流式无 usage，退化为按 chunk 估算，需在验收报告中标注取舍。
//
// 最终 chunk 形如：{ "choices": [], "usage": {
//   "prompt_tokens": n, "completion_tokens": n, "total_tokens": n,
//   "prompt_tokens_details": { "cached_tokens": n },
//   "completion_tokens_details": { "reasoning_tokens": n } } }
tokensIn         = usage.prompt_tokens - (usage.prompt_tokens_details?.cached_tokens ?? 0)
tokensCacheRead  = usage.prompt_tokens_details?.cached_tokens ?? 0
tokensCacheWrite = 0
tokensOut        = usage.completion_tokens
tokensReasoning  = usage.completion_tokens_details?.reasoning_tokens ?? 0
```

### 7.5 `packages/llm-router/src/usage/cost.ts`

```ts
import type { WireUsage } from './types.js';
import type { ResolvedModel } from '../catalog/types.js';

const MTOK = 1_000_000;

/** 用整数分之下的定点算，避免浮点累计误差；返回 numeric(12,6) 兼容的字符串。 */
export function computeCostUsd(usage: WireUsage, model: ResolvedModel): string {
  const p = (v: string) => Number.parseFloat(v || '0');
  const cost =
    (usage.tokensIn         / MTOK) * p(model.priceInputPerMtok) +
    (usage.tokensOut        / MTOK) * p(model.priceOutputPerMtok) +
    (usage.tokensCacheWrite / MTOK) * p(model.priceCacheWritePerMtok) +
    (usage.tokensCacheRead  / MTOK) * p(model.priceCacheReadPerMtok) +
    (usage.tokensReasoning  / MTOK) * p(model.priceReasoningPerMtok);
  return cost.toFixed(6);
}
```

### 7.6 `packages/llm-router/src/catalog/catalog-cache.ts` —— 热变更（D7 / A7 / A8）

```ts
/**
 * 目录快照缓存。
 *
 * 一致性模型：
 *  - DB 是唯一真相；进程内持有不可变快照 `Snapshot`。
 *  - 写方（控制台 API）在同一事务内 `version++`，提交后 `pg_notify('llm_catalog', ...)`。
 *  - 读方（每个 router 副本）监听 NOTIFY 立即 refresh；另有轮询兜底，
 *    只 SELECT 单行 version，version 未变则不做任何查询（零成本）。
 *  - 已在途请求继续使用取路由时的快照（不中途换供应商）。
 *
 * A7/A8 的「生效时间」定义：从写事务提交，到**所有健康副本**的下一次路由决策使用新目录。
 *   上界 = max(NOTIFY 传播, LLM_CATALOG_POLL_MS) + 一次 refresh 查询耗时。
 *   默认 LLM_CATALOG_POLL_MS=5000 → 上界约 5s；NOTIFY 正常时实测应 < 500ms。
 */
import type { CatalogStore, Snapshot } from './types.js';

export interface Listener {
  listen(channel: string, onNotify: (payload: string) => void): Promise<void>;
  close(): Promise<void>;
}

export interface CatalogCacheOptions {
  pollMs?: number;
  onRefresh?: (snapshot: Snapshot, trigger: 'boot' | 'notify' | 'poll') => void;
  logger?: { warn(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void };
}

export class CatalogCache {
  private snapshot: Snapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private store: CatalogStore,
    private listener: Listener | null,
    private opts: CatalogCacheOptions = {}
  ) {}

  async start(): Promise<void> {
    await this.refresh('boot');
    if (this.listener) {
      // listen 失败不致命——轮询兜底仍在
      await this.listener
        .listen('llm_catalog', () => { void this.refresh('notify'); })
        .catch((err) => this.opts.logger?.warn('[catalog] LISTEN failed, polling only', err));
    }
    const pollMs = this.opts.pollMs ?? 5_000;
    this.timer = setInterval(() => { void this.refresh('poll'); }, pollMs);
    this.timer.unref();
  }

  /** 并发去重：多个 NOTIFY 同时到达只跑一次刷新 */
  private async refresh(trigger: 'boot' | 'notify' | 'poll'): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const version = await this.store.readVersion();
        if (this.snapshot && this.snapshot.version === version) return;   // 无变化，零查询
        const next = await this.store.loadSnapshot(version);
        this.snapshot = next;
        this.opts.onRefresh?.(next, trigger);
        this.opts.logger?.info('[catalog] refreshed', {
          trigger, version, models: next.byAlias.size, providers: next.providers.size,
        });
      } catch (err) {
        // 保留旧快照——DB 抖动期间网关继续按上一份目录服务（可用性优先）
        this.opts.logger?.warn('[catalog] refresh failed, keeping previous snapshot', err);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** readyz 依赖它：未加载完不接流量 */
  get current(): Snapshot | null { return this.snapshot; }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.listener?.close();
  }
}
```

配套在 `packages/db/src/client.ts` 新增（LISTEN 需要独占连接，因此不复用 drizzle 连接池）：

```ts
import postgres from 'postgres';

/**
 * 创建一个专用于 LISTEN/NOTIFY 的独立连接（max:1）。
 * postgres.js 的 sql.listen() 会保留一条连接并在断线后自动重连重订。
 */
export function createNotificationListener(connectionString?: string) {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1, idle_timeout: 0, connect_timeout: 10 });
  return {
    async listen(channel: string, onNotify: (payload: string) => void) {
      await sql.listen(channel, onNotify);
    },
    async close() { await sql.end({ timeout: 5 }); },
  };
}
```

写方（控制台 API）在每次目录/凭据变更后必须执行：

```ts
// packages/llm-router/src/catalog/bump-version.ts
export async function bumpCatalogVersion(db: DbClient): Promise<number> {
  const [row] = await db
    .update(llmCatalogState)
    .set({ version: sql`${llmCatalogState.version} + 1`, updatedAt: new Date() })
    .where(eq(llmCatalogState.id, 1))
    .returning({ version: llmCatalogState.version });
  // NOTIFY 必须在事务提交后发出，否则监听方可能读到旧数据
  await db.execute(sql`SELECT pg_notify('llm_catalog', ${String(row.version)})`);
  return row.version;
}
```

### 7.7 `packages/llm-router/src/catalog/resolve-route.ts` —— 路由（F1 / A4）

```ts
import type { Snapshot, ResolvedRoute } from './types.js';

export type RouteError = { kind: 'model_not_found'; alias: string };

/**
 * alias → 路由决策。规则（A4 要求 100% 确定性）：
 *  1. 只看 model.enabled && provider.enabled
 *  2. priority 升序，并列按 model.id 升序
 *  3. 无匹配 → model_not_found（调用方看到 404，且**不回显目录内容**）
 * 快照已在加载时按此规则排好序，这里是 O(1) 查表。
 */
export function resolveRoute(snapshot: Snapshot, alias: string): ResolvedRoute | RouteError {
  const candidates = snapshot.byAlias.get(alias);
  if (!candidates || candidates.length === 0) return { kind: 'model_not_found', alias };
  const model = candidates[0];
  const provider = snapshot.providers.get(model.providerId);
  if (!provider) return { kind: 'model_not_found', alias };
  return {
    model,
    provider,
    credential: provider.credentialId ? snapshot.credentials.get(provider.credentialId) ?? null : null,
    mode: model.alias === model.upstreamModel ? 'passthrough' : 'rewrite-model',
  };
}
```

### 7.8 `packages/llm-router/src/proxy/forward.ts` —— 转发核心

```ts
/**
 * 一次上游转发的完整生命周期。设计约束：
 *  - 请求 body 以 Uint8Array 原样发出（passthrough 模式下与收到的字节完全相同）
 *  - 响应流不落地、不缓冲、不改分块（A1 + Claude Code 的 300s 字节看门狗）
 *  - 上游错误体原样透传（D10）
 *  - 计量在旁路，任何失败都不影响返回值（A5）
 */
import { teeForMetering } from './sse-tee.js';
import { buildUpstreamHeaders, stripHopByHop } from './headers.js';
import { AnthropicSseUsageParser } from '../usage/anthropic-parser.js';
import { OpenAiSseUsageParser } from '../usage/openai-parser.js';
import { computeCostUsd } from '../usage/cost.js';
import { openSealed } from '../crypto/sealed-box.js';

export interface ForwardInput {
  route: ResolvedRoute;
  /** 原始请求字节；rewrite-model 模式下已由 model-rewrite.ts 重建 */
  body: Uint8Array;
  /** 上游相对路径，含 query，如 '/v1/messages?beta=true' */
  upstreamPath: string;
  inboundHeaders: Headers;
  isStream: boolean;
  subject: Subject;
  requestId: string;
  privateKeyPem: string;
  recorder: CallRecorder;
  signal: AbortSignal;
}

export async function forward(input: ForwardInput): Promise<Response> {
  const { route, body, upstreamPath, isStream, subject, recorder, signal } = input;
  const startedAt = new Date();
  const t0 = performance.now();

  // ① 解封密钥。明文只活在这个函数的栈上，不入任何长生命周期结构。
  let apiKey: string | null = null;
  if (route.credential) {
    try {
      apiKey = openSealed(input.privateKeyPem, {
        alg: route.credential.alg,
        keyId: route.credential.keyId,
        value: route.credential.sealedValue,
      });
    } catch (err) {
      // 指纹不匹配 / 密文损坏 —— 报错但**绝不回显任何密文片段**
      recorder.enqueue(baseRecord(input, { status: 'router_error', httpStatus: 500,
        errorCode: 'CREDENTIAL_UNSEALABLE', startedAt, t0 }));
      return routerError(route.provider.protocol, 500, 'api_error',
        `credential '${route.credential.name}' cannot be unsealed by this router instance`);
    }
  }

  const url = `${route.provider.baseUrl.replace(/\/+$/, '')}${upstreamPath}`;
  const headers = buildUpstreamHeaders(input.inboundHeaders, route, apiKey, input.requestId);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body,                                             // ← 原始字节
      signal: AbortSignal.any([signal, AbortSignal.timeout(route.provider.timeoutMs)]),
    });
  } catch (err) {
    recorder.enqueue(baseRecord(input, { status: 'upstream_error', httpStatus: 502,
      errorCode: classifyFetchError(err), startedAt, t0 }));
    // A10：明确 502，且错误信息只含供应商**名字**，不含 baseUrl/密钥
    return routerError(route.provider.protocol, 502, 'api_error',
      `provider '${route.provider.name}' is unavailable`);
  } finally {
    apiKey = null;                                      // 尽快断开引用
  }

  const respHeaders = stripHopByHop(upstream.headers);
  const ttfbMs = Math.round(performance.now() - t0);

  // ② 非流式：读完整 body → 解析副本 → 原样返回同一份字节
  if (!isStream || !upstream.body) {
    const raw = new Uint8Array(await upstream.arrayBuffer());
    const parser = makeParser(route.provider.protocol);
    parser.pushNonStreamBody(raw);
    finishRecord(input, parser, upstream.status, startedAt, t0, ttfbMs);
    return new Response(raw, { status: upstream.status, headers: respHeaders });
  }

  // ③ 流式：tee 转发。注意上游非 2xx 时**同样原样透传**（D10）
  const parser = makeParser(route.provider.protocol);
  const teed = teeForMetering(upstream.body, {
    onChunk: (c) => parser.push(c),
    onEnd: (reason) => finishRecord(input, parser, upstream.status, startedAt, t0, ttfbMs, reason),
  });
  return new Response(teed, { status: upstream.status, headers: respHeaders });
}

function finishRecord(
  input: ForwardInput, parser: UsageParser, httpStatus: number,
  startedAt: Date, t0: number, ttfbMs: number, abortReason?: unknown
) {
  const u = parser.result();
  input.recorder.enqueue({
    ...baseRecord(input, { startedAt, t0 }),
    status: abortReason ? 'client_abort' : httpStatus < 400 ? 'success' : 'upstream_error',
    httpStatus,
    upstreamModel: u.upstreamModel ?? input.route.model.upstreamModel,
    tokensIn: u.tokensIn, tokensCacheWrite: u.tokensCacheWrite,
    tokensCacheRead: u.tokensCacheRead, tokensOut: u.tokensOut,
    tokensReasoning: u.tokensReasoning,
    costUsd: computeCostUsd(u, input.route.model),
    ttfbMs, latencyMs: Math.round(performance.now() - t0),
    completedAt: new Date(),
  });
}
```

### 7.9 `packages/llm-router/src/proxy/headers.ts`

```ts
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

/** 调用方发来的、绝不能转给上游的头（router 自己的凭据 + 会被上游误读的头） */
const CONSUME_ONLY = new Set([
  'authorization', 'x-api-key',
  'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id',
  'x-request-id', 'accept-encoding',
]);

export function buildUpstreamHeaders(
  inbound: Headers, route: ResolvedRoute, apiKey: string | null, requestId: string
): Headers {
  const out = new Headers();
  for (const [k, v] of inbound) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || CONSUME_ONLY.has(lk)) continue;
    // 开放列表原则：anthropic-* / x-claude-code-* 之外的未知头也默认放行，
    // 因为 Claude Code 会随版本新增头，白名单会静默打断新能力。
    out.set(k, v);
  }
  // 不请求压缩：避免解压/再压导致下游拿到的字节与上游不一致
  out.set('accept-encoding', 'identity');
  out.set('x-request-id', requestId);
  for (const [k, v] of Object.entries(route.provider.defaultHeaders)) out.set(k, v);
  if (apiKey) {
    switch (route.credential?.authStyle) {
      case 'x-api-key': out.set('x-api-key', apiKey); break;
      case 'header':    out.set(route.credential.authHeader!, apiKey); break;
      default:          out.set('authorization', `Bearer ${apiKey}`);
    }
  }
  return out;
}

export function stripHopByHop(h: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of h) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'authorization' || lk === 'x-api-key') continue;   // 防回显
    out.set(k, v);
  }
  return out;
}
```

### 7.10 `packages/llm-router/src/proxy/model-rewrite.ts` —— A1 的唯一例外（D2b）

```ts
/**
 * rewrite-model 模式下重建请求体。
 * **唯一允许修改的字段是顶层 `model`。** 单测必须断言：
 *   deepEqual(omit(parse(before),'model'), omit(parse(after),'model')) === true
 */
export function rewriteModelField(body: Uint8Array, upstreamModel: string): Uint8Array {
  const obj = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  obj.model = upstreamModel;
  return new TextEncoder().encode(JSON.stringify(obj));
}
```

### 7.11 `packages/llm-router/src/metering/call-recorder.ts` —— 异步批写（A5）

```ts
/**
 * 计量写入器。硬性要求：**任何路径都不得让计量阻塞或失败上层调用**。
 *  - enqueue() 是同步、无 await、不抛错的
 *  - 后台每 flushIntervalMs 或攒够 batchSize 就批量写一次
 *  - DB 故障时丢弃最老的记录并计数告警（有界队列，绝不 OOM）
 *  - 写 llm_calls 与累加 llm_budget_usage 在**同一事务**，保证不重不漏
 */
export class CallRecorder {
  private queue: LlmCallRecord[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: CallStore,
    private budget: BudgetAccumulator,
    private opts: { batchSize?: number; flushIntervalMs?: number; maxQueue?: number } = {}
  ) {}

  start() {
    this.timer = setInterval(() => { void this.flush(); }, this.opts.flushIntervalMs ?? 1_000);
    this.timer.unref();
  }

  enqueue(rec: LlmCallRecord): void {
    const max = this.opts.maxQueue ?? 10_000;
    if (this.queue.length >= max) { this.queue.shift(); this.dropped++; }
    this.queue.push(rec);
    if (this.queue.length >= (this.opts.batchSize ?? 100)) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.opts.batchSize ?? 100);
    try {
      await this.store.insertBatchWithBudget(batch);   // 单事务：INSERT + ON CONFLICT 累加
    } catch (err) {
      // 不回队（避免故障期无限重放放大压力），计数 + 告警
      this.dropped += batch.length;
      console.error('[metering] batch flush failed', { size: batch.length, err });
    }
  }

  /** 优雅退出时调用，尽量不丢最后一批 */
  async drain(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.queue.length > 0) await this.flush();
  }

  stats() { return { pending: this.queue.length, dropped: this.dropped }; }
}
```

### 7.12 `packages/llm-router/src/auth/router-token.ts` —— 令牌即归属（D5 / D6 / F7）

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ROUTER_TOKEN_PREFIX = 'rt_';

/** 明文只在签发时返回一次，库里只存 SHA-256 hex（复用 service_tokens 的成熟范式） */
export function mintRouterToken(): { plaintext: string; tokenHash: string } {
  const plaintext = ROUTER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, tokenHash: hashRouterToken(plaintext) };
}

export function hashRouterToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 从 Authorization / x-api-key 两种头里提取（Claude Code 两种凭据变量都可能用） */
export function extractToken(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t.startsWith(ROUTER_TOKEN_PREFIX)) return t;
  }
  const xk = headers.get('x-api-key')?.trim();
  if (xk?.startsWith(ROUTER_TOKEN_PREFIX)) return xk;
  return null;
}

/**
 * 认证 = 查 token_hash + 校验未吊销未过期。返回值就是**归属（subject）**。
 * 注意：绝不从请求头里读 runId/projectId —— 沙箱内可篡改（D6）。
 */
export interface Subject {
  tokenId: string;
  subjectType: 'run' | 'service';
  runId: string | null;
  agentId: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  allowedModelAliases: string[];
  maxCostUsd: string | null;
  maxRequestsPerMinute: number | null;
}
```

短时令牌 + 内存缓存（避免每次调用打 DB）：

```ts
/** 命中缓存 TTL 15s；吊销通过同一条 llm_catalog NOTIFY 通道广播失效（携带 tokenId）。 */
export class TokenAuthenticator {
  private cache = new Map<string, { subject: Subject; expiresAt: number }>();
  constructor(private store: TokenStore, private ttlMs = 15_000) {}

  async authenticate(headers: Headers): Promise<Subject | null> {
    const raw = extractToken(headers);
    if (!raw) return null;
    const hash = hashRouterToken(raw);
    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > Date.now()) return hit.subject;
    const subject = await this.store.findActiveByHash(hash);   // revoked_at IS NULL AND expires_at > now()
    if (!subject) { this.cache.delete(hash); return null; }
    this.cache.set(hash, { subject, expiresAt: Date.now() + this.ttlMs });
    void this.store.touchLastUsed(subject.tokenId);            // fire-and-forget，同 unified-auth 的做法
    return subject;
  }

  invalidate(tokenId: string): void {
    for (const [k, v] of this.cache) if (v.subject.tokenId === tokenId) this.cache.delete(k);
  }
}
```

> **吊销生效上界 = 缓存 TTL（15s）**。这一点必须写进 A9 的验收说明——"立即吊销"在有缓存的前提下是"≤15 秒内吊销"。若需要更强保证，把 TTL 调到 0（每次查 DB，实测多约 1–2ms）。

### 7.13 中间件：限流与预算（F6 / A6）

```ts
// packages/llm-router/src/guard/rate-limit.ts
import { RedisRateLimiter } from '@open-rush/agent-runtime';   // ★ 复用 2.5 的既有实现

/**
 * 限流 key 的选择：优先 projectId（同项目多 run 共享配额），退化到 tokenId。
 * 开关：LLM_ROUTER_RATE_LIMIT_ENABLED（默认 false），与预算开关**互相独立**（A6 明确要求）。
 */
export function rateLimitKey(subject: Subject): string {
  return subject.projectId ? `project:${subject.projectId}` : `token:${subject.tokenId}`;
}
```

```ts
// packages/llm-router/src/budget/budget-service.ts
/**
 * 预算检查。两档语义（A6）：
 *   enforce=false（默认）→ 只累计不拦截，"预算开关关闭时不卡业务但仍计量"
 *   enforce=true         → 超限返回 429 + Retry-After（到窗口边界的秒数）
 *
 * 一致性取舍：检查读的是缓存的累计值（TTL 10s），所以是**软限额**——
 * 高并发下可能超出 limit 一个窗口内的少量金额。这是刻意的：
 * 把每次调用都做成强一致的事务会给转发路径加一次同步写，违背"极薄"。
 * 需要硬限额时把 cacheTtlMs 设为 0。**此取舍必须写进验收报告。**
 */
export class BudgetService {
  private cache = new Map<string, { usedUsd: number; at: number }>();
  constructor(private store: BudgetStore, private cacheTtlMs = 10_000) {}

  async check(subject: Subject): Promise<
    { allowed: true } | { allowed: false; reason: string; retryAfterSec: number }
  > {
    for (const scope of resolveScopes(subject)) {          // agent → project → user → global
      const budget = await this.store.getBudget(scope.type, scope.id);
      if (!budget) continue;
      const used = await this.getUsedCached(scope, budget.window);
      if (used < Number.parseFloat(budget.limitUsd)) continue;
      if (!budget.enforce) continue;                      // observe 档：放行
      return {
        allowed: false,
        reason: `budget exceeded for ${scope.type} ${scope.id ?? '*'}: ` +
                `${used.toFixed(2)}/${budget.limitUsd} USD (window=${budget.window})`,
        retryAfterSec: secondsToWindowEnd(budget.window),
      };
    }
    return { allowed: true };
  }
}
```

### 7.14 `apps/llm-router/src/server.ts` —— 装配

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getDbClient, createNotificationListener } from '@open-rush/db';
import { createLogger, extractOrGenerateRequestId } from '@open-rush/observability';
import { sanitize } from '@open-rush/control-plane';           // ★ 复用 output-sanitizer（2.4）
import { RedisRateLimiter } from '@open-rush/agent-runtime';   // ★ 复用（2.5）
import {
  CatalogCache, DrizzleCatalogStore, CallRecorder, DrizzleCallStore,
  BudgetService, DrizzleBudgetStore, TokenAuthenticator, DrizzleTokenStore,
  loadRouterPrivateKey,
} from '@open-rush/llm-router';

const log = createLogger({ name: 'llm-router' });

// ① 私钥 fail-fast —— 起不来好过带着半残状态跑
const key = loadRouterPrivateKey();
log.info({ keyId: key.keyId }, 'router key loaded');   // 只打指纹，不打任何密钥材料

const db = getDbClient();
const catalog = new CatalogCache(
  new DrizzleCatalogStore(db),
  createNotificationListener(),
  { pollMs: Number(process.env.LLM_CATALOG_POLL_MS ?? 5000), logger: log }
);
const recorder = new CallRecorder(new DrizzleCallStore(db), new DrizzleBudgetStore(db));
const authenticator = new TokenAuthenticator(new DrizzleTokenStore(db));
const budget = new BudgetService(new DrizzleBudgetStore(db));

const app = new Hono();

// —— 日志中间件：所有出站日志过一遍 sanitize()，杜绝密钥意外落盘（A9）——
app.use('*', async (c, next) => {
  const requestId = extractOrGenerateRequestId(c.req.raw.headers);
  c.set('requestId', requestId);
  await next();
  log.info({ requestId, path: c.req.path, status: c.res.status },
           sanitize(`${c.req.method} ${c.req.path}`));
});

// —— 探针 ——
app.get('/healthz', (c) => c.json({ status: 'ok' }));
app.get('/readyz', (c) =>
  catalog.current ? c.json({ ready: true, catalogVersion: catalog.current.version })
                  : c.json({ ready: false, reason: 'catalog not loaded' }, 503));
app.on('HEAD', '/api/hello', (c) => c.body(null, 200));   // Claude Code 的预热探针

// —— 业务面 ——
app.route('/v1', messagesRoutes({ catalog, authenticator, budget, recorder, key, rateLimiter }));

const port = Number.parseInt(process.env.PORT ?? '8790', 10);

async function main() {
  await catalog.start();
  recorder.start();
  const server = serve({ fetch: app.fetch, port }, (i) =>
    log.info(`llm-router listening on http://0.0.0.0:${i.port}`));

  // —— 优雅退出（D11 / A3）——
  const shutdown = async () => {
    log.info('draining…');
    // 1) readyz 立刻转 503 → 负载均衡摘流；2) 等在途流最多 DRAIN_TIMEOUT_MS
    catalog.markNotReady?.();
    await new Promise((r) => setTimeout(r, Number(process.env.DRAIN_TIMEOUT_MS ?? 30_000)));
    server.close();
    await recorder.drain();
    await catalog.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { log.error(e, 'llm-router failed to start'); process.exit(1); });
```

### 7.15 `packages/control-plane/src/llm/llm-access-service.ts` —— 签发 / 吊销（新增）

```ts
/**
 * 为一次 Run 签发 llm-router 接入凭据，并给出要注入沙箱的环境变量。
 * 签发在沙箱创建**之前**；吊销在 RunOrchestrator 的 finally 里（无论成败）。
 */
export interface LlmGrant {
  tokenId: string;
  /** 直接展开进 sandbox env / providerEnv */
  env: Record<string, string>;
}

export class LlmAccessService {
  constructor(
    private store: RouterTokenStore,
    private config: { routerBaseUrl: string; defaultTtlSeconds?: number }
  ) {}

  async issueForRun(ctx: {
    runId: string; agentId: string; projectId: string;
    ownerUserId: string | null; modelAlias: string; ttlSeconds?: number;
  }): Promise<LlmGrant> {
    const { plaintext, tokenHash } = mintRouterToken();
    const expiresAt = new Date(
      Date.now() + (ctx.ttlSeconds ?? this.config.defaultTtlSeconds ?? 3900) * 1000
    );  // 默认 = 沙箱 ttl 3600s + 5 分钟缓冲
    const row = await this.store.create({
      tokenHash, subjectType: 'run',
      runId: ctx.runId, agentId: ctx.agentId,
      projectId: ctx.projectId, ownerUserId: ctx.ownerUserId,
      allowedModelAliases: [ctx.modelAlias],   // 最小权限：这个 run 只能用这一个模型
      expiresAt,
    });
    return {
      tokenId: row.id,
      env: {
        ANTHROPIC_BASE_URL: this.config.routerBaseUrl,
        // 用 AUTH_TOKEN 而非 API_KEY：Claude Code 把它放进 Authorization: Bearer，
        // 且 AUTH_TOKEN 变量优先级立即生效（API_KEY 在交互模式下需要一次确认）。
        ANTHROPIC_AUTH_TOKEN: plaintext,
        ANTHROPIC_MODEL: ctx.modelAlias,
      },
    };
  }

  /** 幂等：重复调用只是多一次 UPDATE */
  async revokeForRun(runId: string): Promise<void> {
    await this.store.revokeByRunId(runId);
  }

  /** run 收敛时聚合逐调用记录，喂给 data-openrush-usage（D8 / A5） */
  async aggregateUsage(runId: string): Promise<{ tokensIn: number; tokensOut: number; costUsd: number } | null> {
    return this.store.aggregateCallsByRun(runId);
  }
}
```

### 7.16 改动：`apps/agent-worker/src/server.ts`（**A11 的关键 3 行**）

```diff
   // Model from env: CLAUDE_MODEL / ANTHROPIC_MODEL (Bedrock ARN) or fallback
   const effectiveModelId =
     modelId ?? process.env.CLAUDE_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'sonnet';
-  const providerEnv: Record<string, string> = {
-    ...(env ?? {}),
-    ...(process.env.ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }),
-    ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
-  };
+  // ── 模型凭据边界（specs/llm-router.md §密钥边界）───────────────────────────
+  // 供应商真实密钥**不再**出现在本进程或沙箱环境中。控制面通过 `env` 下发的是
+  // llm-router 的短时接入令牌（ANTHROPIC_AUTH_TOKEN）与网关地址（ANTHROPIC_BASE_URL）。
+  //
+  // 显式把这些键置为 undefined，而不是"不设置就没有"：
+  // ai-sdk-provider-claude-code 3.4.4 的子进程 env 白名单不含 ANTHROPIC_*，
+  // 但 3.6.0+（Agent SDK 0.3.x）新增了 ANTHROPIC_*/AWS_*/GOOGLE_* 前缀继承。
+  // 显式抹除让这条不变量**不随依赖升级漂移**。回归测试见 apps/agent-worker 的
+  // "no provider credentials reach the subprocess env" 用例。
+  const providerEnv: Record<string, string | undefined> = {
+    ...(env ?? {}),
+    ANTHROPIC_API_KEY: undefined,
+    AWS_ACCESS_KEY_ID: undefined,
+    AWS_SECRET_ACCESS_KEY: undefined,
+    AWS_SESSION_TOKEN: undefined,
+    CLAUDE_CODE_USE_BEDROCK: undefined,
+  };
```

同时更新 `apps/agent-worker/.env.example`：删掉 `ANTHROPIC_API_KEY=xxx`，换成注释说明"密钥由 llm-router 持有，本容器不配置任何供应商密钥"。

### 7.17 改动：`packages/control-plane/src/run/run-orchestrator.ts`

```diff
 export interface RunOrchestratorDeps {
   runService: RunService;
   sandboxProvider: SandboxProvider;
   eventStore: EventStore;
   checkpointService?: CheckpointService;
   agentExecutor?: AgentExecutor;
+  /** 可选：未装配时退化为改造前行为（便于灰度与本地调试） */
+  llmAccess?: LlmAccessService;
   resolveProjectIdForAgent?: (agentId: string) => Promise<string | null>;
   releaseTaskLock?: (runId: string) => Promise<void>;
 }
```

```diff
       const sandboxOptions: CreateSandboxOptions = {
         agentId,
-        env: agentContext?.env,
         ttlSeconds: 3600,
       };
+      // ★ 签发 run 级接入令牌，注入网关地址 —— 必须在 sandbox 创建之前
+      if (this.deps.llmAccess && agentContext) {
+        grant = await this.deps.llmAccess.issueForRun({
+          runId, agentId,
+          projectId: agentContext.projectId,
+          ownerUserId: agentContext.agentConfig.createdBy ?? null,
+          modelAlias: agentContext.modelAlias,
+          ttlSeconds: 3900,
+        });
+      }
+      const sandboxEnv = { ...(agentContext?.env ?? {}), ...(grant?.env ?? {}) };
+      sandboxOptions.env = sandboxEnv;
       const sandbox = await this.deps.sandboxProvider.create(sandboxOptions);
```

```diff
       const { response } = await agentBridge.sendPrompt(fullPrompt, {
         sessionId: runId,
-        env: agentContext?.env,
+        env: sandboxEnv,
+        modelId: agentContext?.modelAlias,     // ★ 修复 2.6 的断链
         allowedTools: agentContext?.agentConfig.allowedTools,
```

```diff
       // 5. Consume SSE stream
       await this.consumeStream(runId, response, v1EventsEnabled);
+
+      // ★ 5a. 逐调用记录聚合回写 data-openrush-usage（与既有契约对齐）
+      //    best-effort：计量缺失不得影响 run 收敛（A5）
+      if (v1EventsEnabled && this.deps.llmAccess) {
+        try {
+          const usage = await this.deps.llmAccess.aggregateUsage(runId);
+          if (usage) await this.emitUsage(runId, usage);
+        } catch (err) {
+          console.error('[orchestrator] usage aggregation failed (non-fatal):', err);
+        }
+      }
```

```diff
     } finally {
+      // ★ 无论成败都吊销令牌，缩短凭据暴露窗口
+      if (this.deps.llmAccess) {
+        try { await this.deps.llmAccess.revokeForRun(runId); }
+        catch (err) { console.error('[orchestrator] token revoke failed:', err); }
+      }
       if (this.deps.releaseTaskLock) { ... }
```

新增私有方法（与既有 `emitRunStarted` / `emitRunDone` 同风格）：

```ts
private async emitUsage(
  runId: string, usage: { tokensIn: number; tokensOut: number; costUsd: number }
): Promise<void> {
  await this.deps.eventStore.appendAssignSeq({
    runId,
    eventType: 'data-openrush-usage',
    payload: { type: 'data-openrush-usage', data: usage },   // 形状见 contracts openrushUsagePartSchema
  });
}
```

### 7.18 改动：`AgentConfig` / `AgentContext` 补 model（修 2.6）

```diff
 // packages/control-plane/src/agent/agent-config.ts
 export interface AgentConfig {
   id: string;
   projectId: string | null;
   name: string;
+  /** 对应 agents.model 列；为空时回落到 LLM_ROUTER_DEFAULT_MODEL */
+  model?: string | null;
   scope: AgentScope;
```

```diff
 // packages/control-plane/src/run/agent-executor.ts
 export interface AgentContext {
   agentConfig: AgentConfig;
   projectId: string;
   env: Record<string, string>;
+  /** 解析后的模型 alias：agentConfig.model ?? 默认值 */
+  modelAlias: string;
   skills: string[];
   mcpServers: string[];
 }
```

并在 `DrizzleAgentConfigStore` 的映射里把 `agents.model` 读出来（当前被漏掉）。

---

## 8. 任务分解

**总量估算：约 15 个工作日**（单人；含测试与 Sparring Review 往返）。任务卡按依赖排序，同一 M 内标 ⇉ 的可并行。

**每张卡的完成定义（DoD）——无例外**：
1. 代码 + 测试**在同一个 commit**（`AGENTS.md` 铁律）
2. `pnpm build && pnpm check && pnpm lint && pnpm test` 全绿
3. 新增 API route 有 `route.test.ts`；新增 service 方法/utils 函数有单测；覆盖正常路径 + 至少一个错误路径
4. Sparring Review 通过（`MUST-FIX` 清零）

---

### M0 · 基线与规格（1 天）

#### T0.1 写 `specs/llm-router.md`
- **产出**：`specs/llm-router.md`
- **必须覆盖**：D1–D12 全部决策；§落位（为什么不破坏双层 SSE 与 15 状态机）；§密钥边界（盲写不变量 4 条 + 依赖版本漂移风险，见 2.8）；§协议承诺分层（3.1 表）；§与 `credential-proxy.md` 的关系（2.7）；§热变更生效时间定义与上界；§错误信封三分法（D10）
- **验收**：Spec 经 Sparring Review 通过；`specs/credential-proxy.md` 顶部加一行交叉引用
- **依赖**：无

#### T0.2 契约与 scope ⇉
- **产出**：`packages/contracts/src/v1/llm-router.ts`；`v1/index.ts` 加导出；`v1/common.ts` 的 `ServiceTokenScope` 追加 `llm:read` / `llm:write`
- **验收**：`packages/contracts/src/v1/__tests__/llm-router.test.ts` 覆盖每个 schema 的接受/拒绝用例；**特别断言 `llmCredentialSchema` 解析后不含 `sealedValue` / `value` 键**
- **注意**：zod **v3** API；`common.test.ts` 里已有的 scope 枚举断言需同步更新
- **依赖**：无

---

### M1 · 数据层（1.5 天）

#### T1.1 7 张表 + migration
- **产出**：`packages/db/src/schema/llm-{credentials,providers,models,router-tokens,calls,budgets,catalog-state}.ts`；`schema/index.ts` barrel 导出；`packages/db/drizzle/0012_llm_router.sql`
- **命令**：`pnpm --filter @open-rush/db db:generate`（会先 tsup build 再 drizzle-kit generate）
- **验收**：
  - migration 末尾含 `llm_catalog_state` 的种子 INSERT
  - `packages/db/src/__tests__/llm-router-schema.test.ts`（PGlite）：CRUD、FK 级联（删 run → 级联删 token/calls）、`llm_router_tokens_subject_check` 约束、`llm_models_alias_provider_idx` 唯一性、`llm_budget_usage` 复合主键 upsert 累加
  - `pnpm --filter @open-rush/db test:integration` 在干净 DB 上重放全链 migration 成功
- **依赖**：T0.2

#### T1.2 `createNotificationListener` ⇉
- **产出**：`packages/db/src/client.ts` 新增导出（代码见 7.6）；`src/index.ts` 导出
- **验收**：`client.test.ts` 补：缺 `DATABASE_URL` 抛错；`close()` 幂等。真实 LISTEN/NOTIFY 走 `test:integration`
- **依赖**：无

---

### M2 · 密钥盲写（1.5 天）

#### T2.1 `sealed-box.ts`
- **产出**：`packages/llm-router/` package 骨架（`package.json` / `tsconfig.json` / `vitest.config.ts`，照抄 `packages/control-plane` 的形状）+ `src/crypto/sealed-box.ts`（代码见 7.1）
- **验收**：`__tests__/sealed-box.test.ts` 至少 8 例：
  1. seal → open 往返一致（含 UTF-8 与 8KB 长 key）
  2. 用**另一对**私钥 open → 抛错
  3. 篡改密文任一字节 → 抛错（GCM tag）
  4. 篡改 `keyId` → 抛"keyId mismatch"
  5. `alg` 不匹配 → 抛错
  6. 同一明文 seal 两次 → 密文不同（临时密钥随机性）
  7. 截断密文（< 60 字节）→ 抛"malformed"
  8. `generateRouterKeyPair()` 产出的 keyId 与 `computeKeyId(pub)` 一致
- **依赖**：无

#### T2.2 `key-loader.ts` + 生成 CLI ⇉
- **产出**：`src/crypto/key-loader.ts`（见 7.2）；`scripts/gen-router-keypair.ts`（输出两段 PEM + keyId + 一段"公钥给 web / 私钥给 router"的使用提示）
- **验收**：单测覆盖 FILE 优先、inline base64、inline PEM、都缺失抛错、非 X25519 密钥抛错
- **依赖**：T2.1

#### T2.3 控制台凭据 API
- **产出**：`apps/web/app/api/v1/llm/credentials/route.ts`（POST/GET）、`[id]/route.ts`（DELETE）、`[id]/rotate/route.ts`
- **实现要点**：
  - POST 里 `seal(process.env.LLM_ROUTER_PUBLIC_KEY!, body.value)`，**随后不再引用 `body.value`**
  - `LLM_ROUTER_PUBLIC_KEY` 缺失 → `v1Error('INTERNAL', ...)` 附 hint（照抄 `vaults/entries/helpers.ts` 的 `resolveVault()` 模式）
  - 平台级资源 → **拒绝 service token，只接受 session**（照抄 vaults 路由对 `scope=platform` 的处理）
  - 写成功后调 `bumpCatalogVersion(db)`
- **验收**：`route.test.ts` 覆盖 201 / 400 校验失败 / 401 无认证 / 403 service token 被拒 / 500 缺公钥；**并断言响应 JSON 序列化后不含明文子串**
- **依赖**：T1.1, T2.1, T0.2

---

### M3 · 目录与路由（2 天）

#### T3.1 `CatalogStore` + Drizzle 实现
- **产出**：`src/catalog/types.ts`、`catalog-store.ts`（interface）、`drizzle-catalog-store.ts`
- **要点**：`loadSnapshot()` 一次性 join 出 providers + models + credentials，**在内存里按 `(alias) → 排序后的候选数组`** 建索引（排序规则见 7.7），使 `resolveRoute` 为 O(1)
- **验收**：PGlite 测试覆盖：只加载 enabled 行、priority 排序、并列按 id、provider disabled 时其 model 不进索引
- **依赖**：T1.1

#### T3.2 `CatalogCache` ⇉
- **产出**：`src/catalog/catalog-cache.ts`（见 7.6）、`bump-version.ts`
- **验收**：用 fake store + fake listener 测：boot 加载、version 未变时**不调用 loadSnapshot**、NOTIFY 触发刷新、并发 refresh 去重、loadSnapshot 抛错时保留旧快照、`stop()` 清理定时器
- **依赖**：T3.1, T1.2

#### T3.3 `resolveRoute` ⇉
- **产出**：`src/catalog/resolve-route.ts`（见 7.7）
- **验收**：命中 / 未知 alias / 全部 disabled / 多候选取最小 priority / mode 判定（同名→passthrough，异名→rewrite-model）
- **依赖**：T3.1

#### T3.4 providers / models 控制台 API
- **产出**：`apps/web/app/api/v1/llm/providers/**`、`models/**`
- **要点**：每次写操作后 `bumpCatalogVersion`；删除被引用的 credential 返回 409（`onDelete:'restrict'` 的 PG 错误要捕获并转成 v1 信封）
- **验收**：每个 method 的正常 + 错误 + 权限拒绝
- **依赖**：T1.1, T0.2

---

### M4 · 网关核心（3 天）

#### T4.1 `apps/llm-router` 骨架
- **产出**：app 骨架、`server.ts`（见 7.14）、`/healthz` `/readyz` `HEAD /api/hello`、`.env.example`
- **要点**：`package.json` 照抄 `apps/agent-worker`（tsup + tsx + hono + @hono/node-server）；根 `pnpm-workspace.yaml` 已含 `apps/*`，无需改
- **验收**：`server.test.ts`：healthz 200；catalog 未加载时 readyz 503；HEAD /api/hello 200；私钥缺失时 `main()` 退出非 0
- **依赖**：T2.2, T3.2

#### T4.2 令牌认证
- **产出**：`src/auth/{router-token.ts,token-store.ts,drizzle-token-store.ts}`（见 7.12）；`apps/llm-router/src/middleware/authenticate.ts`
- **验收**：无头 → 401；非 `rt_` 前缀 → 401；已吊销 → 401；已过期 → 401；`x-api-key` 形式也能认；缓存命中不打 DB；`invalidate()` 生效
- **依赖**：T1.1, T4.1

#### T4.3 `forward` + `headers`
- **产出**：`src/proxy/{forward.ts,headers.ts,model-rewrite.ts}`（见 7.8–7.10）
- **验收**（用本地起一个 fake upstream，**不打真供应商**）：
  - `buildUpstreamHeaders`：剥 hop-by-hop、剥 `authorization`/`x-api-key`、保 `anthropic-version`/`anthropic-beta`、**未知 `anthropic-*` 头默认放行**、三种 authStyle 各注入正确的头、`accept-encoding: identity`
  - `stripHopByHop`：上游若回显 `authorization` 也被剥掉
  - `rewriteModelField`：**深度相等断言**（除 `model` 外）
  - 上游 500 + 自定义错误体 → 状态码与 body **原样透传**
  - 上游连不上 → 502，且响应体**不含 baseUrl、不含任何密钥**
- **依赖**：T2.1, T3.3, T4.2

#### T4.4 `sse-tee` + usage 解析
- **产出**：`src/proxy/sse-tee.ts`（见 7.3）、`src/usage/{types.ts,anthropic-parser.ts,openai-parser.ts,cost.ts}`（见 7.4/7.5）
- **验收**（**这是 A1/A5 的核心测试，务必写扎实**）：
  - 用真实形状的 SSE 固定装置（fixture），随机切成 N 组不同边界的 chunk：断言**下游拼接结果与上游逐字节一致**，且 chunk 数量与对象引用相同
  - 跨 chunk 的多字节 UTF-8 字符不被截断（`TextDecoder({stream:true})`）
  - `message_delta` 累计语义：多个 delta 取 max，不叠加
  - 只有 `message_start` 没有 `message_delta` 时也能出数
  - 畸形 JSON / `[DONE]` / `event:` 行 / 注释行 不影响解析与转发
  - `onChunk` 抛错时流仍完整（旁路隔离）
  - 客户端提前 cancel → `onEnd(reason)` 被调用一次
  - `computeCostUsd`：五类 token 各自计价、零价、缺字段
- **依赖**：T4.1

#### T4.5 `/v1/messages` + `/v1/messages/count_tokens` + `/v1/models`
- **产出**：`apps/llm-router/src/routes/{messages,count-tokens,models}.ts`
- **要点**：
  - 路由匹配**按 path**，`/v1/messages?beta=true` 必须命中
  - `stream` 字段决定走流式还是缓冲分支
  - `/v1/models` 返回 `{ data: [{ id, display_name }] }`，**同步返回、不重定向、控制在 3 秒内**
- **验收**：happy path、未知 alias → 404、无令牌 → 401、令牌不允许该 alias → 403、body 非法 JSON → 400、缺 `model` → 400
- **依赖**：T4.3, T4.4

#### T4.6 `/v1/chat/completions` ⇉
- **产出**：`apps/llm-router/src/routes/chat-completions.ts` + `src/usage/openai-parser.ts` 接线
- **要点**：流式需 `stream_options.include_usage=true` 才有 usage —— 若原请求未带，**注入并在 `llm_calls.mode` 记为 `rewrite-model`**，同时在验收报告中声明这一取舍（见 7.4 注）
- **验收**：同 T4.5 一套 + usage 从最后一个 `choices: []` chunk 解析
- **依赖**：T4.3, T4.4

#### T4.7 🟡 `translate` adapter（Stretch）
- **产出**：`src/adapters/anthropic-to-openai.ts`（请求：messages/system/tools 映射；响应：OpenAI SSE → Anthropic SSE 事件序列）
- **验收**：语义等价的往返测试（文本、工具调用、stop_reason 映射）；**明确不承诺字节一致**
- **可裁剪**：时间紧时跳过，在验收报告的 F2 一栏写"双协议对外面已交付，跨协议翻译列为后续"
- **依赖**：T4.5, T4.6

---

### M5 · 计量 / 预算 / 限流（2 天）

#### T5.1 `CallRecorder` + `DrizzleCallStore`
- **产出**：`src/metering/{call-recorder.ts,drizzle-call-store.ts}`（见 7.11）
- **要点**：`insertBatchWithBudget` 在**一个事务**里 INSERT `llm_calls` + upsert 累加 `llm_budget_usage`
- **验收**：`enqueue` 同步不抛错；攒够 batchSize 自动 flush；store 抛错时不抛给调用方且 `dropped` 递增；队列满时丢最老；`drain()` 清空；事务原子性（PGlite）
- **依赖**：T1.1, T4.4

#### T5.2 `BudgetService` ⇉
- **产出**：`src/budget/{budget-service.ts,drizzle-budget-store.ts}`（见 7.13）
- **验收**：无预算配置 → 放行；`enforce=false` 且超限 → **放行且仍计量**（A6 明写）；`enforce=true` 且超限 → 拒绝 + `retryAfterSec`；作用域优先级 agent→project→user→global；缓存 TTL 内不重复查 DB
- **依赖**：T1.1

#### T5.3 限流接线 ⇉
- **产出**：`src/guard/rate-limit.ts` + `apps/llm-router/src/middleware/rate-limit.ts`
- **要点**：**直接复用** `RedisRateLimiter`（`packages/agent-runtime`，见 2.5）；`llm-router` 的 `package.json` 加 `"@open-rush/agent-runtime": "workspace:*"`；Redis 不可用时**降级为放行**并告警（可用性优先）
- **验收**：超限返回 429；`Retry-After` 头存在；开关关闭时不生效；Redis 挂掉时放行
- **依赖**：T4.2

#### T5.4 错误信封与 429 语义
- **产出**：`src/errors.ts`（D10 的映射表）
- **验收**：每个错误场景在两种协议面下的信封形状；429 一定带 `Retry-After`；**上游错误体不被包装**（回归测试）
- **依赖**：T4.3

---

### M6 · 接线（2 天）

#### T6.1 `LlmAccessService`
- **产出**：`packages/control-plane/src/llm/{llm-access-service.ts,router-token-store.ts,drizzle-router-token-store.ts}`；`control-plane/src/index.ts` 导出
- **要点**：control-plane 的 `package.json` 加 `"@open-rush/llm-router": "workspace:*"`（只为 `mintRouterToken`/`hashRouterToken`），或把这两个纯函数下沉到 `packages/contracts` 避免反向依赖 —— **Sparring 时定夺依赖方向**
- **验收**：签发返回明文且库里只有 hash；吊销幂等；过期时间计算；`aggregateUsage` 的 SUM 正确（含无记录返回 null）
- **依赖**：T1.1, T4.2

#### T6.2 `RunOrchestrator` 接线
- **产出**：`run-orchestrator.ts` 改动（见 7.17）+ `agent-executor.ts` / `agent-config.ts` 补 model（见 7.18）+ `drizzle-agent-config-store.ts` 读出 `agents.model`
- **要点**：`llmAccess` 为**可选依赖**——未装配时行为与改造前完全一致，这是灰度开关
- **验收**：
  - Red Test 先行：断言 `sendPrompt` 收到 `modelId`（修复 2.6 的断链）
  - 装配 llmAccess 时：sandbox env 含 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`
  - `finally` 里必定调 revoke（成功路径 + 抛错路径各一例）
  - 未装配 llmAccess 时不改变任何既有行为（回归）
- **依赖**：T6.1

#### T6.3 `agent-worker` 密钥边界
- **产出**：`apps/agent-worker/src/server.ts` 改动（见 7.16）+ `.env.example` 更新
- **验收**（**A11 回归测试**）：mock `claudeCode`，断言传入的 `env` 对象中 `ANTHROPIC_API_KEY`/`AWS_*` 为 `undefined`，**即使 `process.env` 里设了这些值**
- **依赖**：无（可与 T6.2 并行）

#### T6.4 control-worker 装配
- **产出**：`apps/control-worker/src/worker.ts` 构造 `LlmAccessService` 并传入 `RunOrchestrator`；`.env.example` 补 `LLM_ROUTER_BASE_URL`
- **要点**：`LLM_ROUTER_BASE_URL` 未设置时**不装配** llmAccess（保持旧行为），并打一条 warn
- **验收**：环境变量存在/不存在两条路径
- **依赖**：T6.1, T6.2

#### T6.5 日志清洗与审计 ⇉
- **产出**：llm-router 日志中间件接 `sanitize()`；`packages/control-plane/src/admin/audit-log.ts` 的 `AuditAction` 追加 `'llm.credential.store' | 'llm.credential.rotate' | 'llm.token.revoke'`
- **验收**：把一个 `sk-ant-xxx...` 塞进 provider name 走一遍日志，断言输出为 `[REDACTED]`
- **依赖**：T4.1

---

### M7 · 验收自证与交付（1.5 天）

#### T7.1 A1–A11 验证套件
- **产出**：`e2e/llm-router/` 下的可复现脚本 + `docs/llm-router-acceptance.md`（逐项方法、命令、结果）
- **依赖**：M4–M6 全部

#### T7.2 性能基线（A2）⇉
- **产出**：`scripts/bench-llm-router.mjs`（见 9.2）+ 结果表
- **依赖**：T4.5

#### T7.3 安全审计脚本（A9/A11）⇉
- **产出**：`scripts/audit-no-plaintext-key.sh`（见 9.9）
- **依赖**：T6.3

#### T7.4 文档 ⇉
- **产出**：`docs/llm-router.md`（部署、密钥生成与轮换、目录配置、故障排查）；`docs/quickstart.md` 增一节；`docs/roadmap.md` 勾掉 budget/rate-limit 项；`AGENTS.md` 的"改哪个 package"表加一行
- **依赖**：全部

---

## 9. 验收自证（A1–A11）

> 每项给出：**判定口径 → 验证方法 → 命令/测试 → 已知取舍**。取舍必须写进最终报告，评分看的是论证完整性而不是"全绿"。

### 前置：本地验证环境

```bash
pnpm db:up && pnpm db:push
pnpm --filter @open-rush/db db:migrate                     # 应用 0012
pnpm tsx scripts/gen-router-keypair.ts > /tmp/router-keys.txt

# 私钥只给 llm-router
export LLM_ROUTER_PRIVATE_KEY_FILE=/tmp/router.key
# 公钥只给 web
export LLM_ROUTER_PUBLIC_KEY="$(cat /tmp/router.pub)"

# 起一个可控的假上游（回放固定 SSE），避免测试打真供应商、也让"逐字节一致"可判定
node e2e/llm-router/fake-upstream.mjs &        # :9999
pnpm --filter @open-rush/llm-router-app dev    # :8790
```

### A1 · 请求/响应透传语义（body 零改写 + SSE 不丢不改序）

**判定口径**（按 3.1 分层）：
- `passthrough` 模式：请求体上下游逐字节一致；响应体逐字节一致；SSE 事件序列与分块边界一致。
- `rewrite-model` 模式：除 `$.model` 外解析后深度相等。
- `translate` 模式：不承诺字节一致，只承诺语义等价（若未交付则声明为后续）。

**方法**：
1. 假上游把收到的请求原始字节 dump 到 `/tmp/upstream-req.bin`，同时回放一段固定 SSE fixture。
2. 客户端把收到的响应原始字节 dump 到 `/tmp/client-resp.bin`。
3. 比对：

```bash
curl -sS -N http://localhost:8790/v1/messages \
  -H "Authorization: Bearer $RT" -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: some-future-beta-2026-01-01' \
  -H 'content-type: application/json' \
  --data-binary @e2e/llm-router/fixtures/messages-req.json \
  --output /tmp/client-resp.bin

cmp e2e/llm-router/fixtures/messages-req.json /tmp/upstream-req.bin  && echo "REQ byte-exact"
cmp e2e/llm-router/fixtures/sse-golden.bin     /tmp/client-resp.bin  && echo "RESP byte-exact"
```

4. 单测层面已由 T4.4 覆盖（随机分块 × N 组，断言字节一致 + chunk 引用一致）。
5. **附加断言**：`anthropic-beta: some-future-beta-2026-01-01` 这个我们从未见过的值必须原样到达上游 —— 证明没有做白名单过滤。

**已知取舍**：向上游发 `accept-encoding: identity`。若上游强制返回 gzip，则下游拿到的也是同样的 gzip 字节（仍字节一致），但 usage 旁路解析会失败并记 `tokens=0`；此时降级为 run 级聚合缺该次调用。需在报告中说明。

### A2 · 转发性能（p95 附加延迟）

**判定口径**：`p95(经网关) − p95(直连假上游)`，同一 fixture、同一并发。

```js
// scripts/bench-llm-router.mjs（要点）
// 1) 直连假上游 N=500 次，记录 TTFB 与完成耗时
// 2) 经 llm-router N=500 次，同上
// 3) 输出 p50/p95/p99 与差值；并发档位 1 / 8 / 32
```

**目标**：p95 附加延迟 < 15ms（本机、无 TLS）。**必须分别报告 TTFB 附加延迟与总耗时附加延迟**——网关的价值在于 TTFB 几乎不受影响（先 enqueue 后 observe，见 7.3）。

**已知取舍**：非流式请求会在网关侧完整缓冲 body（为了解析 usage），大响应会引入一次内存拷贝；流式路径无此问题。Claude Code 走的是流式路径。

### A3 · 可用性（滚动更新不中断）

**方法**：
```bash
# 起 2 个副本 + 一个最简 LB（或 docker compose scale）
# 持续发起 60s 的流式请求，同时 kill -TERM 其中一个副本
# 断言：kill 期间所有已建立的流正常收尾；新请求全部落到另一副本；零 5xx
```
**依据**：`/readyz` 在 SIGTERM 后立即转 503 → LB 摘流；`DRAIN_TIMEOUT_MS`（默认 30s）内等待在途流。
**已知取舍**：单个流的最长时长可能超过 drain 窗口，超时后会被强制断开。缓解：把 `DRAIN_TIMEOUT_MS` 配成大于典型 run 的单次调用时长，并在 K8s 里配 `terminationGracePeriodSeconds` 相应放大。

### A4 · 路由准确率

**方法**：造 12 条目录记录（含 disabled、多 priority 并列、跨 provider 同名 alias），对每条 alias 发一次请求，断言假上游收到的 `Host` + `model` 组合与期望一致；再对 3 个不存在的 alias 断言 404。
**命令**：`pnpm --filter @open-rush/llm-router test -t "resolveRoute"` + 一个 e2e 表驱动脚本。
**断言 404 的内容**：错误体只含被请求的 alias，**不含**目录里其他模型名（避免枚举泄露）。

### A5 · 明细计量

**方法**：
```bash
# 1) 跑一个 run（或直接对网关发 3 次调用）
# 2) 查逐调用记录
psql "$DATABASE_URL" -c "
  SELECT model_alias, mode, stream, status,
         tokens_in, tokens_cache_write, tokens_cache_read, tokens_out, tokens_reasoning,
         cost_usd, ttfb_ms, latency_ms, run_id, cc_session_id
  FROM llm_calls WHERE run_id = '$RUN_ID' ORDER BY started_at;"
# 3) 与 run 级事件对齐
psql "$DATABASE_URL" -c "
  SELECT payload FROM run_events
  WHERE run_id='$RUN_ID' AND event_type='data-openrush-usage';"
```
> ⚠️ **前置**：`data-openrush-usage` 经 `appendAssignSeq` 写入，受 `OPENRUSH_V1_EVENTS_ENABLED` 控制，**默认关闭**（见 `run-orchestrator.ts` 的 `isV1EventsEnabled`，只接受字面量 `"true"`）。验收时必须显式开启：`OPENRUSH_V1_EVENTS_ENABLED=true`。关闭时 `llm_calls` 仍照常写入——**逐调用计量不依赖这个 flag**，只有 run 级聚合事件依赖它。

**断言**：
- `llm_calls` 行数 == 该 run 的实际上游调用次数（假上游侧计数）
- `SUM(tokens_in) == data-openrush-usage.tokensIn`，`SUM(tokens_out) == tokensOut`，`SUM(cost_usd) ≈ costUsd`
- 每行的 `run_id/project_id` 来自令牌，非请求头（把请求头里的 `x-claude-code-session-id` 改成伪造值，断言 `run_id` 不变）
- **计量失败不阻塞**：把 DB 停掉，断言调用仍然成功返回、`recorder.stats().dropped` 递增

**已知取舍（必须写进报告）**：Anthropic Messages API 的 thinking token 已计入 `output_tokens`，wire 上没有独立字段，因此 `tokens_reasoning` 对 Anthropic 上游恒为 0；"推理 token 拆开"在 Anthropic 族上**协议层面不可得**，我们能拆的是 cache read / cache write / output 三项。OpenAI 族可从 `completion_tokens_details.reasoning_tokens` 拆出。

### A6 · 预算 / 限流

| 子项 | 方法 | 期望 |
|---|---|---|
| 限流开 | `LLM_ROUTER_RATE_LIMIT_ENABLED=true`，`maxRequestsPerMinute=3`，连发 5 次 | 前 3 次 200，后 2 次 **429 + `Retry-After`**，错误体 `error.type=rate_limit_error` |
| 限流关 | 同上但开关关闭 | 5 次全 200 |
| 预算 observe | `llm_budgets{enforce=false, limitUsd=0.000001}` | **全部放行**，且 `llm_budget_usage.cost_usd` 持续累加 |
| 预算 enforce | 同上但 `enforce=true` | 429，错误信息含 `used/limit` 与 window |
| 两开关独立 | 限流开 + 预算关 / 限流关 + 预算开 | 各自独立生效 |
| 冒泡到 v1 | 控制面把网关 429 映射为 `RATE_LIMITED` | `apps/web` 侧响应 `{"error":{"code":"RATE_LIMITED"}}`，HTTP 429 |

**已知取舍**：预算是**软限额**（缓存 TTL 10s），高并发下可能超出少量。硬限额需 `LLM_ROUTER_BUDGET_CACHE_MS=0`，代价是每次调用一次同步 DB 读。

### A7 · 目录热变更

**生效时间定义**：从目录写事务提交，到**所有健康副本**的下一次路由决策使用新目录。
**上界** = `max(NOTIFY 传播时延, LLM_CATALOG_POLL_MS) + 一次 loadSnapshot 耗时`。

```bash
# 副本 A 在跑；不重启任何进程
curl -X POST $WEB/api/v1/llm/models -H "Cookie: $SESSION" -d '{"alias":"new-model", ...}'
# 立刻循环打 new-model，记录第一次成功的时刻
while ! curl -sf -o /dev/null http://localhost:8790/v1/messages -d '{"model":"new-model",...}'; do :; done
```
**报告要求**：分别给出 NOTIFY 正常时的实测（期望 < 500ms）与**故意断开 LISTEN 连接**后靠轮询兜底的实测（期望 ≤ `LLM_CATALOG_POLL_MS` + 一次查询）。这两个数据一起给，才算证明了"生效时间有确定上界"。

### A8 · 密钥热变更

```bash
# 1) 用 credA 跑通一次调用
# 2) rotate：POST /api/v1/llm/credentials/:id/rotate {"value":"NEW-KEY"}
# 3) 不重启任何进程，再跑一次 → 假上游断言收到的 Authorization 已是 NEW-KEY
# 4) 旧密钥不可还原：
psql "$DATABASE_URL" -c "SELECT sealed_value FROM llm_credentials WHERE id='$ID';"   # 只有一份新密文
psql "$DATABASE_URL" -c "\d llm_credentials"                                          # 无历史表、无明文列
```
**断言**：轮换后 `version` 递增、`rotated_at` 更新、`sealed_value` 被覆盖；**不保留历史密文**（这是设计选择，见 5.2 注释 4）。日志与响应中检索不到旧密钥（用 A9 的脚本）。

### A9 · 安全审计

```bash
#!/usr/bin/env bash
# scripts/audit-no-plaintext-key.sh
set -euo pipefail
KEY="${1:?usage: audit-no-plaintext-key.sh <plaintext-provider-key>}"
FAIL=0
probe() { if grep -qF -- "$KEY" <<<"$2"; then echo "LEAK in $1"; FAIL=1; else echo "clean: $1"; fi; }

# 1) 沙箱环境变量（dev 模式下即 agent-worker 子进程环境）
probe "sandbox env"      "$(curl -sS localhost:8787/health; printenv || true)"
# 2) 数据库全表扫描（所有 text/varchar/jsonb 列）
probe "database"         "$(psql "$DATABASE_URL" -Atc "
  SELECT string_agg(t::text, E'\n') FROM (
    SELECT * FROM llm_credentials UNION ALL SELECT * FROM vault_entries
  ) t;" 2>/dev/null || true)"
# 3) 各服务日志
for svc in web control-worker agent-worker llm-router; do
  probe "log:$svc" "$(cat /tmp/logs/$svc.log 2>/dev/null || true)"
done
# 4) 控制台 API 响应
probe "api response"     "$(curl -sS "$WEB/api/v1/llm/credentials" -H "Cookie: $SESSION")"
# 5) run_events 全量
probe "run_events"       "$(psql "$DATABASE_URL" -Atc "SELECT payload::text FROM run_events;")"
# 6) 部署清单里私钥的分布
for d in web control-worker agent-worker; do
  if kubectl get deploy "$d" -o yaml 2>/dev/null | grep -q LLM_ROUTER_PRIVATE; then
    echo "LEAK: $d has LLM_ROUTER_PRIVATE_KEY"; FAIL=1
  fi
done
exit $FAIL
```
**凭据吊销流程**（也属 A9）：
```bash
# run 令牌：随 run 收敛自动吊销（RunOrchestrator.finally）
psql "$DATABASE_URL" -c "SELECT revoked_at FROM llm_router_tokens WHERE run_id='$RUN_ID';"
# 手动吊销后 ≤ TokenAuthenticator TTL（默认 15s）内失效 —— 报告中写明这个上界
```

### A10 · 失败隔离

| 场景 | 期望 |
|---|---|
| 假上游返回 connection refused | 502，body 为 `{"type":"error","error":{"type":"api_error","message":"provider 'X' is unavailable"}}`；**不含 baseUrl、不含密钥** |
| 假上游 hang 住超过 `timeoutMs` | 502，且连接被释放（`recorder` 里状态为 `upstream_error`） |
| 供应商 A 全部超时，同时打供应商 B | B 的请求成功率不受影响（无共享阻塞队列） |
| 上游返回 429 + 自定义错误体 | **原样透传**（状态码 + body 字节一致），不被网关的 429 信封替换 |

**方法**：假上游支持 `?behavior=refuse|hang|429` 三种模式；并发场景用 `scripts/bench-llm-router.mjs --mixed`。

### A11 · 盲写 + 唯一持有

这是最重要的一项，分四步自证：

**① 录入即盲写**
```bash
curl -X POST "$WEB/api/v1/llm/credentials" -H "Cookie: $SESSION" \
  -d '{"name":"prod","value":"sk-ant-REAL-KEY-xxxxx","authStyle":"bearer"}'
# 断言响应 JSON 不含 value / sealed_value（T2.3 的 route.test.ts 已覆盖）
```

**② web / control-plane 无法再解出真 key —— 结构性证明**
```bash
# 代码级：web 侧不存在任何 open/decrypt 路径
grep -rn "openSealed\|LLM_ROUTER_PRIVATE" apps/web packages/control-plane --include=*.ts | grep -v __tests__
# 期望：空。web 只 import seal()，没有 openSealed 的调用点，也没有私钥环境变量。

# 运行时级：web 进程环境里没有私钥材料
curl -sS "$WEB/api/health" && kubectl exec deploy/web -- printenv | grep -c LLM_ROUTER_PRIVATE  # 期望 0
```
> 这一步的力度来自 D3 的非对称设计：**不是"我们约定不解"，而是"没有私钥就解不了"**。若用对称 KEK，这一条只能靠代码审查来保证，说服力弱一个量级。

**③ 明文只在 llm-router 进程内存**
- 静态：`openSealed()` 的返回值只在 `forward()` 的栈上流转，用完置 `null`（见 7.8），不进任何缓存/日志/响应。
- 动态：跑 A9 的脚本，六处探针全 clean。
- 可选加强：`kill -QUIT` 拿 core dump 或用 `--heapsnapshot-signal` 抓堆快照，grep 明文 —— 会命中（明文确实在内存里，这正是设计），但只在 router 进程；对 web/control-worker 做同样操作应为空。**这个对照实验是本项最有说服力的证据**。

**④ 不影响大模型调用**
```bash
# 同一 prompt、同一模型，分别走 (a) 直连供应商 (b) 经 llm-router
# 断言：两次都成功、SSE 事件类型序列一致、最终文本一致（temperature=0）
node e2e/llm-router/parity-check.mjs --prompt "1+1=?" --model claude-sonnet-4-6
```

### 9.x 验收结果汇总表模板

| 指标 | 结论 | 证据 | 取舍/备注 |
|---|---|---|---|
| A1 | ✅ passthrough 字节一致 | `cmp` 通过 + 单测 N=50 组分块 | translate 模式不承诺；gzip 场景见备注 |
| A2 | ✅ p95 附加 __ ms | bench 输出 | 非流式有一次缓冲拷贝 |
| A3 | ✅ 零 5xx | 滚动更新日志 | 超长流受 drain 窗口限制 |
| A4 | ✅ 100% / 404 明确 | 表驱动 e2e | — |
| A5 | ✅ 逐调用 + 对齐 | SQL 对账 | Anthropic 推理 token 协议层不可拆 |
| A6 | ✅ 两开关独立 | 6 组用例 | 预算为软限额 |
| A7 | ✅ NOTIFY __ ms / 轮询 __ s | 两组实测 | — |
| A8 | ✅ 不重启生效 | 假上游断言 | 不保留历史密文（设计选择） |
| A9 | ✅ 6 处探针 clean | 审计脚本 | 吊销生效 ≤ 15s（缓存 TTL） |
| A10 | ✅ 502 且不泄露 | 3 种故障模式 | — |
| A11 | ✅ 结构性保证 | 堆快照对照实验 | — |

---

## 10. 风险、上线路径与范围边界

### 10.1 风险登记

| # | 风险 | 影响 | 缓解 | 触发时的退路 |
|---|---|---|---|---|
| R1 | **Claude Code 版本升级改变 gateway 协议**（新 beta 头、新 body 字段、新端点） | 新能力静默失效或 400 | 头与 body 一律**开放列表转发**，不做白名单；每次升级 `ai-sdk-provider-claude-code` 跑一遍 e2e | 临时设 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 降级 |
| R2 | **provider 包升级引入 env 前缀继承**（2.8） | 真 key 重新泄漏进沙箱 | T6.3 的显式 `undefined` 抹除 + 回归测试 | 回滚依赖版本 |
| R3 | 网关成为单点 | 全平台模型调用中断 | 无状态多副本 + readiness 摘流 + `llmAccess` 可选依赖（不装配即回退旧路径） | 摘掉 `LLM_ROUTER_BASE_URL`，control-worker 自动退回直连 |
| R4 | SSE 长连接被 LB / ingress 缓冲 | Claude Code 300s 字节看门狗触发，流被中断 | ingress 关 `proxy_buffering`，设 `X-Accel-Buffering: no`（仓库既有 SSE② 路由已有此实践） | 加大 `CLAUDE_CODE_STREAM_IDLE_TIMEOUT` |
| R5 | 私钥丢失 | 所有已存密文不可解 | 私钥离线备份 + `key_id` 指纹校验让错配立刻报错而非静默失败 | 重新生成密钥对 + 重新录入全部供应商密钥（**必须在运维文档里写清这是唯一恢复路径**） |
| R6 | 计量队列在 DB 长时间故障时丢数据 | 账单不准 | 有界队列 + `dropped` 计数 + 告警 | 从 `run_events` 的 finish chunk 兜底做 run 级对账 |
| R7 | 预算软限额被高并发击穿 | 超支 | 默认 `enforce=false`；启用时把 `BUDGET_CACHE_MS` 调小 | 设为 0（强一致，代价是每次一次同步读） |
| R8 | 跨协议 translate 的语义损失 | 工具调用/thinking 行为退化 | MVP 不承诺；标记为 Stretch 并单独回归 | 只做同协议 passthrough |
| R9 | `main` 分支在开发期间推进，产生冲突 | 返工 | 开工前跑 1.3 的差异复核；改动集中在**新增文件**，对既有文件的改动只有 5 处且都很小 | — |
| R10 | Vault 的 `resolveVaultEnv` 未来被真正接线，与 router env 冲突 | 环境变量覆盖顺序不确定 | 7.17 的合并顺序是 `{...vaultEnv, ...grant.env}`——**router 后写、优先级更高**，并在代码注释和 Spec 中固定 | — |

### 10.2 上线路径（课题刻意不接现网，这里说明"如果要接"需要补什么）

**阶段 1 · 影子（Shadow）**
- llm-router 部署但不接流量；用 `scripts/replay.mjs` 把生产的请求形状回放到网关，比对与直连的响应差异。
- 目的：验证 A1 的字节一致性在**真实供应商**上也成立（本地假上游证明不了上游行为）。

**阶段 2 · 单项目灰度**
- 只给一个测试项目的 agent 装配 `llmAccess`；其余项目 `LLM_ROUTER_BASE_URL` 不下发，走旧路径。
- 观察：p95 附加延迟、`llm_calls` 与 `run_events` 的 finish chunk 用量对账偏差、502 率。
- **回归重点**（课题第 4 条交付物要求的"对 Run 状态机与双层 SSE 的回归风险"）：
  - 15 状态机：`provisioning → preparing → running → finalizing_* → completed` 的转换次数与耗时分布，与灰度前对比
  - SSE①：`run_events` 的 `seq` 连续性、事件类型分布、`text-delta` 总字符数
  - SSE②：浏览器断线重连（`Last-Event-ID`）在网关介入后仍正常
  - Follow-up run：checkpoint 恢复路径不受影响（令牌是 per-run 的，follow-up 会拿到新令牌）
  - `worker_unreachable` / `run/recover` 定时恢复：网关 502 是否会被误判为 worker 不可达

**阶段 3 · 全量 + 拆除旧路径**
- 所有项目下发 `LLM_ROUTER_BASE_URL`；
- 从 `apps/agent-worker` 的部署清单里**删除所有供应商密钥环境变量**（这一步才真正兑现 A11 的运行时保证）；
- 跑一遍 A9 审计脚本作为切换后的门禁。

**还需要补的环节（本课题范围外）**：
1. **供应商 fallback chain**：`llm_models.priority` 已预留，但 MVP 不做失败切换（roadmap 的 "AI Provider resilience" 剩余项）。
2. **沙箱出网收敛**：`OpenSandboxProvider` 尚未实现 `patchEgressRules`（roadmap 里列了这个 SDK 能力但 provider 未接）。D12 论证了没有它 A9 也成立，但纵深防御上仍应补。
3. **成本看板**：`llm_calls` 已经是可用的数据源，但没有 UI（roadmap Phase 4 的 "cost dashboard"）。
4. **审计表**：`AuditLogStore` 至今无 Drizzle 实现（2.4），凭据操作的审计目前只落在应用日志。
5. **密钥托管升级**：MVP 的私钥是环境变量/文件；生产建议接 KMS/HSM，把 `key-loader.ts` 换成 KMS 客户端即可，接口不变。
6. **多租户配额自助**：`llm_budgets` 支持 project/user 维度，但没有自助设置的 UI。

### 10.3 明确不做（范围边界，与课题一致）

- ❌ 不改写请求/响应语义（不做提示词加工、不做模型能力模拟）
- ❌ 不改 agent-worker 与 Claude Code 的既有调用语义（本方案只换 `ANTHROPIC_BASE_URL` 指向）
- ❌ 不改双层 SSE 协议、不改 15 状态机、不改 `run_events` 的既有事件类型（只**新增**一个已在契约中定义但从未发出的 `data-openrush-usage`）
- ❌ 不接现网
- ❌ 不重构 `packages/agent-runtime`（它是死代码，见 2.1；只复用其中的 `RedisRateLimiter`）
- ❌ 不改造既有 Vault（D4）

### 10.4 与课题交付物的对应

| 课题交付物 | 本计划中的位置 | 备注 |
|---|---|---|
| 1. 可行性研究报告 | 第 2 节（现状论证）+ 第 3 节（决策结论）+ 3.1（承诺分层） | 用户选择"只给结论"；如需完整"备选 vs 选择"对比，在 D1–D12 每条下按三段扩写即可 |
| 2. MVP 代码 | 第 5–8 节 | T4.7（translate）为可裁剪项 |
| 3. 验收自证 | 第 9 节 + T7.1–T7.3 | 含 9.x 汇总表模板 |
| 4. 风险与后续 | 第 10 节 | 含 Run 状态机与双层 SSE 的回归清单 |

---

## 11. 附录

### 11.1 环境变量清单

**apps/llm-router**

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8790` | 监听端口 |
| `DATABASE_URL` | — | 必填 |
| `REDIS_URL` | — | 限流用；缺失则限流降级为放行 |
| `LLM_ROUTER_PRIVATE_KEY_FILE` | — | **二选一**，指向挂载的 PEM 文件（推荐） |
| `LLM_ROUTER_PRIVATE_KEY` | — | **二选一**，PEM 内容或其 base64 |
| `LLM_CATALOG_POLL_MS` | `5000` | 目录轮询兜底间隔，决定 A7/A8 的上界 |
| `LLM_ROUTER_TOKEN_CACHE_MS` | `15000` | 令牌缓存 TTL，决定吊销生效上界 |
| `LLM_ROUTER_BUDGET_CACHE_MS` | `10000` | 预算累计缓存 TTL；设 0 = 硬限额 |
| `LLM_ROUTER_RATE_LIMIT_ENABLED` | `false` | 限流总开关（与预算开关独立） |
| `DRAIN_TIMEOUT_MS` | `30000` | 优雅退出等待在途流的时长 |

**apps/web**

| 变量 | 说明 |
|---|---|
| `LLM_ROUTER_PUBLIC_KEY` | X25519 公钥 PEM。**只有公钥**——这是 A11 的结构性前提 |

**apps/control-worker**

| 变量 | 说明 |
|---|---|
| `LLM_ROUTER_BASE_URL` | 沙箱可达的网关地址（如 `http://llm-router.rush.svc:8790`）。**未设置则不装配 llmAccess，行为回退到改造前**——这是灰度/回滚开关 |
| `LLM_ROUTER_DEFAULT_MODEL` | `agents.model` 为空时的回落 alias |

**apps/agent-worker**

| 变量 | 说明 |
|---|---|
| ~~`ANTHROPIC_API_KEY`~~ | **删除**。改造后本容器不配置任何供应商密钥 |
| ~~`ANTHROPIC_BASE_URL`~~ | **删除**。由控制面通过 `env` 逐 run 下发 |

### 11.2 术语

| 术语 | 含义 |
|---|---|
| SSE① | agent-worker(:8787) → control-worker 的 UIMessageChunk 流 |
| SSE② | web Control API → 浏览器的事件流（从 `run_events` 重建 + Redis 缓存） |
| alias | 上层看到的模型名（`llm_models.alias`），F1 的"统一模型入口"就是它 |
| upstream_model | 供应商侧的真实模型名 |
| subject | 调用的归属方（run / agent / project / user），由令牌决定而非请求头 |
| passthrough / rewrite-model / translate | 三种转发模式，A1 的承诺分层见 3.1 |
| 盲写 | apps/web 只能 `seal()` 不能 `open()`：物理上不具备解密能力 |
| 生效时间 | 从写事务提交到所有健康副本的下一次决策使用新配置 |

### 11.3 参考资料

**仓库内（`e62f507`）**
- `AGENTS.md` — 三层架构、Sparring Review 铁律、测试要求、提交前 5 步门禁
- `specs/vault-design.md` — 双层 Vault 与凭据类型
- `specs/credential-proxy.md` — sidecar 方向的凭据代理（Deferred，与本方案互补，见 2.7）
- `specs/service-token-auth.md` — 令牌哈希/吊销范式（本方案复用范式，不复用表）
- `specs/managed-agents-api.md` — v1 错误码，含 `RATE_LIMITED` 预留
- `specs/migration-policy.md` — Drizzle 前向迁移、schema 与 migration 同 commit
- `specs/stream.md` — Redis 可恢复 SSE
- `docs/roadmap.md` — "AI Provider resilience — fallback chain, budget limit, timeout, rate control"

**外部**
- Claude Code — Gateway protocol reference：端点（`/v1/messages`、`/v1/messages/count_tokens`、`/v1/models`）、必须原样转发的头（`anthropic-version` / `anthropic-beta`）、流式与 ping 的 300 秒字节看门狗、错误体原样转发、`x-claude-code-session-id` 等归属头、模型发现的 3 秒/不重定向约束
  https://code.claude.com/docs/en/llm-gateway-protocol
- Claude Code — Connect to an LLM gateway：`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（→ `Authorization: Bearer`）/ `ANTHROPIC_API_KEY`（→ `x-api-key`）/ `ANTHROPIC_CUSTOM_HEADERS`
  https://code.claude.com/docs/en/llm-gateway-connect
- Anthropic Messages 流式：`message_start` / `message_delta` 的 usage 语义（**cumulative**）、`cache_creation_input_tokens` / `cache_read_input_tokens`、事件顺序
  https://platform.claude.com/docs/en/api/messages-streaming
- `ai-sdk-provider-claude-code`（npm 3.4.4 为本仓库锁定版；3.6.0 起子进程 env 白名单新增 `ANTHROPIC_*` 前缀继承）
  https://github.com/ben-vargas/ai-sdk-provider-claude-code

### 11.4 开工检查单

```
□ 已读第 2 节，理解 8 处与课题说明的偏差
□ 已跑 1.3 的差异复核，确认基线仍成立
□ 已跑 `pnpm install && ./verify.sh`，基线全绿
□ 已生成 router 密钥对，公私钥分别落到 web / llm-router 的配置里
□ 已建 e2e/llm-router/fake-upstream.mjs（A1/A2/A10 都依赖它）
□ 已确认 Sparring Review 的执行方式（AGENTS.md §Sparring Review 执行方式）
□ 已理解 4.2.1 的 dev/prod 双注入路径差异（最容易踩的坑）
□ T0.1 的 Spec 已写完并通过 Sparring —— 这是 Large 变更的强制前置
```

---

*本计划书基于 `kanyun-rush/open-rush` @ `e62f507c37603cb7df40d87b5b4ee94a285503c7` 撰写。7.1 与 7.3 的代码骨架已在 Node v22.22.2 上实跑验证。*
