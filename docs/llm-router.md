# llm-router 运维手册

> 统一模型路由网关。所有 LLM 调用收敛到这一层：**对外一个供应商无关的模型入口，
> 对内密钥收敛 + 逐调用计量 + 预算与限流。**
>
> 设计决策的 source of truth 在 [`specs/llm-router.md`](../specs/llm-router.md)；
> 验收结论在 [`docs/llm-router-acceptance.md`](./llm-router-acceptance.md)。
> 本文只讲**怎么部署、怎么配、坏了怎么办**。

---

## 1. 它夹在哪里

```
control-worker ──SSE①── agent-worker ── Claude Code CLI ──▶ [ llm-router ] ──▶ 供应商
                                          ↑ ANTHROPIC_BASE_URL 指到这里
```

**网关夹在 Claude Code CLI 与供应商之间，不是夹在 control-worker 与 agent-worker 之间。**
三个后果：

1. 双层 SSE 与 15 状态机**一个字节都不经过网关**——网关挂了不影响 run 状态机本身。
2. 接入方式就是 Claude Code 官方的 gateway 协议（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`），
   没有私有协议。
3. 沙箱里拿到的是**网关签发的短时令牌**，不是供应商真 key——即使 agent 有 bash 也偷不到东西。

**它是可选依赖。** `LLM_ROUTER_BASE_URL` 不下发时，`RunOrchestrator` 完全退回改造前行为
（不签发令牌、沙箱 env 里没有 `ANTHROPIC_*`、不聚合用量、不吊销）。这是灰度与回滚开关。

---

## 2. 首次部署

### 2.1 生成密钥对（一次性）

```bash
pnpm llm:keygen
```

输出两段 PEM 和一个 `keyId`。**两边不要都配**：

| 材料 | 去处 | 能做什么 |
| --- | --- | --- |
| 公钥 `LLM_ROUTER_PUBLIC_KEY` | **只给 `apps/web`** | 只能 `seal()`，**物理上无法解封** |
| 私钥 `LLM_ROUTER_PRIVATE_KEY_FILE` | **只给 `apps/llm-router`** | 唯一能 `openSealed()` 的进程 |

脚本不写任何文件、不落日志——输出只走 stdout，由人转移进密钥管理系统。

生产建议把私钥挂成 Secret 文件、env 里只放路径（`LLM_ROUTER_PRIVATE_KEY_FILE`）；
inline 的 `LLM_ROUTER_PRIVATE_KEY` 只建议本地开发用。**`FILE` 优先且不回退**——
文件读不到会直接抛，不会悄悄用回 inline 的旧值。

部署后自证私钥没有发给别人（应为空）：

```bash
kubectl get deploy web control-worker agent-worker -o yaml | grep -i LLM_ROUTER_PRIVATE
```

### 2.2 数据库

`0012_llm_router.sql` 建 7 张 `llm_*` 表并种下 `llm_catalog_state` 的单行（`id=1`）。

```bash
pnpm --filter @open-rush/db db:migrate
```

> 那一行**必须存在**，热变更（D7）依赖它。缺了的话所有目录写操作会抛 `CatalogStateMissingError`。

### 2.3 起网关

```bash
pnpm --filter @open-rush/llm-router-service build
LLM_ROUTER_PRIVATE_KEY_FILE=/etc/open-rush/llm-router.key \
DATABASE_URL=postgresql://... \
PORT=8790 \
node apps/llm-router/dist/server.js
```

启动顺序刻意如此：

1. **私钥 fail-fast** —— 起不来好过带着「能转发但不能解封」的半残状态跑，
   那会让每一次真实调用都在上游认证处才炸。
2. **目录首次加载失败不致命** —— `/readyz` 会因此摘流，轮询会继续重试。
   启动期的 DB 抖动不该让副本直接退出。

### 2.4 接线

给 `apps/control-worker` 配 `LLM_ROUTER_BASE_URL=http://llm-router:8790`。
它会在每个 run 开始时签发一枚 per-run 令牌，注入沙箱 env：

```
ANTHROPIC_BASE_URL=http://llm-router:8790
ANTHROPIC_AUTH_TOKEN=rt_<43 chars>
ANTHROPIC_MODEL=<agent 的 alias>
```

并在 `finally` 里吊销它（成功与失败路径都走到）。

> **dev 模式下 env 有两条路径，只改一条会以为网关没生效。**
> `LocalDevSandboxProvider.create()` 完全忽略 `options`，所以 env 必须**同时**传给
> `agentBridge.sendPrompt`。另外要清空 `apps/agent-worker/.env.local` 里的
> `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`，否则子进程会绕过网关直连。

---

## 3. 配置参考

### 3.1 `apps/llm-router`

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8790` | |
| `DATABASE_URL` | — | 必填 |
| `LLM_ROUTER_PRIVATE_KEY_FILE` | — | 私钥文件路径（**推荐**，优先级高于下一条且不回退） |
| `LLM_ROUTER_PRIVATE_KEY` | — | 私钥 PEM 或其 base64 形式（本地开发用） |
| `LLM_CATALOG_POLL_MS` | `5000` | 目录轮询兜底间隔。它是**生效时间上界的分母**（见 A7） |
| `LLM_ROUTER_TOKEN_TTL_MS` | `15000` | 令牌认证的进程内缓存。**它就是吊销生效的上界**。设 0 = 每次查库 |
| `LLM_ROUTER_METERING_ENABLED` | `true` | 关掉则装 NOOP recorder，转发路径代码不变 |
| `LLM_ROUTER_METERING_BATCH_SIZE` | `100` | |
| `LLM_ROUTER_METERING_FLUSH_MS` | `1000` | 批写间隔。调大省 DB、调小减少 run 收敛时对不上账的窗口（见 §5 竞态） |
| `LLM_ROUTER_METERING_MAX_QUEUE` | `10000` | 有界队列；满了丢最旧的并计入 `dropped` |
| `LLM_ROUTER_BUDGET_ENABLED` | `true` | 与限流开关**互相独立** |
| `LLM_ROUTER_BUDGET_CACHE_MS` | `10000` | 预算判定的缓存。**这就是「软限额」的来源**；设 0 得到硬限额，代价是每次一次同步 DB 读 |
| `LLM_ROUTER_RATE_LIMIT_ENABLED` | `false` | 开了但没配 Redis 会打 warn 并**不生效**（不静默当成生效） |
| `LLM_ROUTER_RATE_LIMIT_RPM` | `600` | 令牌未指定 `max_requests_per_minute` 时的默认值 |
| `REDIS_URL` / `REDIS_SENTINELS` / `REDIS_MASTER_NAME` / `REDIS_PASSWORD` | — | 仅限流用 |
| `LLM_ROUTER_TRANSLATE_ENABLED` | `true` | 跨协议翻译总开关。`false` 时跨协议回 404（翻译层出问题时不用回滚镜像的退路） |
| `LLM_ROUTER_TRANSLATE_PING_MS` | `15000` | 翻译流自造心跳的间隔。OpenAI 上游一个 `ping` 都不发，而 Claude Code 的字节看门狗是 300 s |
| `DRAIN_TIMEOUT_MS` | `30000` | 优雅退出时等在途流的时长。**配成大于典型单次调用时长**，K8s 侧同步放大 `terminationGracePeriodSeconds` |

### 3.2 `apps/web`

| 变量 | 说明 |
| --- | --- |
| `LLM_ROUTER_PUBLIC_KEY` | X25519 SPKI PEM 或其 base64 形式。**没有它，凭据录入 API 会回 `INTERNAL` 并给出提示** |

### 3.3 `apps/control-worker`

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_ROUTER_BASE_URL` | — | **不设 = 不装配**，退回改造前行为（会打一条 warn，不静默） |
| `LLM_ROUTER_TOKEN_TTL_SECONDS` | `3900` | 沙箱 ttl 3600 s + 5 分钟缓冲 |
| `LLM_ROUTER_DEFAULT_MODEL` | `sonnet` | `agents.model` 为空时的回落 alias。**它同时是令牌白名单里的那一个值** |

---

## 4. 目录配置

目录是 **DB 唯一真相 + 进程内不可变快照 + `LISTEN/NOTIFY` + 轮询兜底**。

三张表：

- `llm_credentials` — 供应商密钥的**密文信封**（`alg` / `key_id` / `sealed_value`）
- `llm_providers` — `protocol`（`anthropic` / `openai`）、`base_url`、绑定的 `credential_id`、`timeout_ms`
- `llm_models` — `alias` → `(provider_id, upstream_model)`，带 `priority`、`enabled` 与五档定价

控制台 API 在 `apps/web` 的 `/api/v1/llm/{credentials,providers,models}` 下。

**三条硬规矩**

1. **每个 POST / PATCH / DELETE / rotate 都必须调 `bumpCatalogVersion(db)`**，
   且 `pg_notify` 必须在事务提交**之后**发。漏掉的话副本永远看不到那次变更——
   这是这套机制最容易踩的坑。
2. **`alias == upstream_model` 时走字节级零改写**（passthrough）。异名会触发 `rewrite-model`，
   只改 `$.model` 一个字段。能同名就同名。
3. **并列 `priority` 的胜者由 `(priority, id)` 决定，`id` 是 uuid** ——
   不要靠并列 priority 表达偏好，要偏好就把数字拉开。

**生效时间**：`max(NOTIFY 传播时延, LLM_CATALOG_POLL_MS) + 一次 loadSnapshot`。
实测 NOTIFY 27 ms、轮询兜底 1992 ms（`POLL_MS=2000`），见 [验收报告 A7](./llm-router-acceptance.md#a7--目录热变更notify--轮询兜底两组数据--)。

---

## 5. 密钥轮换

```bash
curl -X POST "$WEB/api/v1/llm/credentials/$ID/rotate" \
  -H "Cookie: $SESSION" -H 'content-type: application/json' \
  -d '{"value":"sk-ant-NEW-KEY"}'
```

- 覆盖 `sealed_value`、`version++`、写 `rotated_at`，并 bump 目录版本
- **不重启任何进程**，副本在下一次 NOTIFY / 轮询后拿到新密文
- 轮换期间**已在途**的请求用的是取路由时那一份快照里的凭据，不会中途换 key

> ⚠️ **不保留历史密文**（设计选择，R4 §5.2）。轮换即覆盖，旧密钥从此不可还原，
> 没有一键回滚。轮换前请确认新 key 可用。

---

## 6. 计量、预算、限流

### 6.1 逐调用计量

每次调用写一行 `llm_calls`：归属列（`run_id` / `agent_id` / `project_id` / `owner_user_id`）
**全部来自令牌**；`cc_session_id` / `cc_agent_id` 来自 `x-claude-code-*` 请求头，
**只作分组提示，不参与授权与计费**（沙箱里有 bash，那些头想写什么写什么）。

**计量失败不阻塞调用。** 批写在旁路，recorder 抛错时转发照常返回，丢掉的批计入 `dropped`。

⚠️ **一个已知竞态**：`RunOrchestrator` 一消费完 SSE① 就聚合 `llm_calls` 回写
`data-openrush-usage`，而网关的批写默认 1 s 一批。最后一批还没落库时，run 级聚合会少算甚至为空。
真实部署里这段窗口通常由 run 的收尾工作填上，但**不保证**。要收紧就把
`LLM_ROUTER_METERING_FLUSH_MS` 调小（代价是 DB 写入更碎）。

`data-openrush-usage` 受 `OPENRUSH_V1_EVENTS_ENABLED` 控制且**默认关闭**（只认字面量 `"true"`）。
关闭时 `llm_calls` 照常写入——**逐调用计量不依赖这个 flag**。

### 6.2 预算

`llm_budgets` 支持 `global` / `project` / `user` / `agent` 四种作用域，窗口 `day` / `month` / `total`，
**取最近作用域**。两档：

- `enforce = false`（observe）：超限**放行且照记**，用量继续累加到 `llm_budget_usage`
- `enforce = true`：超限回 **429 + `Retry-After`**，错误信息里带 used/limit/window

**预算是软限额**（缓存 10 s）。要硬限额设 `LLM_ROUTER_BUDGET_CACHE_MS=0`。

### 6.3 限流

复用 `RedisRateLimiter`，滑动窗口，拒绝时回 429 + `Retry-After`（窗口剩余秒数）。
**Redis 不可达时降级放行**——它是容量保护，不是安全边界。

---

## 7. 探针与滚动更新

| 端点 | 语义 |
| --- | --- |
| `GET /healthz` | 进程活着 |
| `GET /readyz` | **目录快照已加载** 且 **没有在排空**。任一不满足回 503 |
| `HEAD/GET /api/hello` | Claude Code 的连接预热探针（不实现会在日志里刷 404） |

优雅退出：`SIGTERM` → `readyz` 立刻 503（LB 摘流）→ 等 `DRAIN_TIMEOUT_MS` → 关监听 →
停目录订阅 → 排空计量队列 → `exit 0`。

实测：摘流期间 485 次请求零 5xx，跨越 SIGTERM 的在途流字节完整收尾。

**ingress 注意**（R7 的 R4）：SSE 长连接必须关 `proxy_buffering` 并设 `X-Accel-Buffering: no`，
否则 Claude Code 的 300 s 字节看门狗会把流判死。

---

## 8. 故障排查

| 症状 | 检查 |
| --- | --- |
| 网关起不来，日志只有一句 `failed to start` | 私钥没配或不是 X25519。`loadRouterPrivateKey` 是 fail-fast 的，这是**故意**的 |
| `/readyz` 一直 503 | 目录没加载上——看 DB 连通性；或者进程正在排空 |
| 所有调用回 500 `credential '…' cannot be unsealed by this router instance` | 私钥与录入时用的公钥**不是一对**。比对 `llm_credentials.key_id` 与启动日志里的 `keyId` |
| 调用回 404 `model '…' not found` | 目录里没有这个 alias，或者它 disabled，或者它的 provider disabled。别忘了写操作要 `bumpCatalogVersion` |
| 调用回 404 `… is not available on this protocol endpoint` | 跨协议且没有可用的翻译器（反方向 / `count_tokens` 未交付，或 `LLM_ROUTER_TRANSLATE_ENABLED=false`） |
| 调用回 403 `model '…' is not allowed for this token` | 令牌的 `allowed_model_aliases` 里没有它。per-run 令牌只放行 agent 解析出的那一个 alias |
| 调用回 401 | 令牌过期 / 已吊销 / 前缀不是 `rt_`。**把供应商真 key 配到网关上会直接 401**，这是有意的 |
| 调用回 502 `provider '…' is unavailable` | 上游连不上或超时。错误体**故意**不含 baseUrl / 主机 / 端口 / 密钥；真实原因在 `llm_calls.error_code` |
| 改了目录但副本没反应 | 十有八九是写路径漏了 `bumpCatalogVersion`。兜底：等 `LLM_CATALOG_POLL_MS` |
| 吊销了令牌但还能用 | 认证缓存 TTL（默认 15 s）。这是**上界**，不是 bug；要立刻生效设 `LLM_ROUTER_TOKEN_TTL_MS=0` |
| 沙箱里 Claude Code 还在直连供应商 | ① `LLM_ROUTER_BASE_URL` 没配（启动日志有 warn）；② dev 下 env 只传了一条路径；③ `apps/agent-worker/.env.local` 里还留着 `ANTHROPIC_BASE_URL` |
| 用量对不上账 | 先看 `llm_calls`（逐调用是准的），再看 `data-openrush-usage`（受 flag 与 §6.1 竞态影响） |

### 泄漏自查

```bash
DATABASE_URL=... AUDIT_LOG_DIR=/var/log/open-rush \
  scripts/audit-no-plaintext-key.sh 'sk-ant-REAL-KEY-...'
```

同时查明文与 base64 两种形态；**跳过的探针会单独列出来，不算通过**。
切换到网关之后（尤其是从 agent-worker 部署清单里删掉供应商密钥那一步之后）应当把它作为门禁跑一次。

---

## 9. 私钥丢失

**这是唯一不可恢复的故障。**

所有 `llm_credentials.sealed_value` 都是用那把公钥封的，私钥没了就再也解不开——
这正是 D3 非对称设计想要的性质，代价也在这里。

**唯一恢复路径**：

1. `pnpm llm:keygen` 生成**新的**密钥对；
2. 新公钥下发给 `apps/web`，新私钥下发给 `apps/llm-router`；
3. **重新录入全部供应商密钥**（`POST /api/v1/llm/credentials`，或对每条已有记录做 rotate）；
4. 每次写完都会 bump 目录版本，副本无需重启。

在第 3 步完成之前，所有走网关的调用都会回 500 `cannot be unsealed by this router instance`。
如果需要立刻恢复服务，可以摘掉 `LLM_ROUTER_BASE_URL` 让 control-worker 退回直连旧路径
（前提是 agent-worker 侧还留着供应商密钥——全量切换之后就没有这条退路了）。

**预防**：私钥离线备份（两份、异地）。`key_id` 指纹校验会让「配错了私钥」立刻报错而不是静默失败。
生产建议接 KMS/HSM——把 `crypto/key-loader.ts` 换成 KMS 客户端即可，接口不变。

---

## 10. 还没做的（范围外）

见 [`ref/R7-风险与上线.md`](./plans/llm-router/ref/R7-风险与上线.md) §10.2：

1. **供应商 fallback chain** —— `llm_models.priority` 已预留，但 MVP 不做失败切换
2. **沙箱出网收敛** —— `OpenSandboxProvider` 尚未实现 `patchEgressRules`（纵深防御，非必需）
3. **成本看板** —— `llm_calls` 已是可用数据源，但没有 UI
4. **审计表** —— `AuditLogStore` 无 Drizzle 实现，凭据操作的审计目前只落应用日志
5. **多租户配额自助** —— `llm_budgets` 支持 project/user 维度，但没有自助设置的 UI
6. **跨协议翻译的反方向**（OpenAI 面 → Anthropic 上游）与 `count_tokens`
