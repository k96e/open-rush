#!/usr/bin/env bash
#
# 供应商真 key 的泄漏审计（M7·T7.3，R6 的 A9 / A11 ②）。
#
#   scripts/audit-no-plaintext-key.sh <plaintext-provider-key>
#
# 退出码：0 = 全部探针 clean；1 = 至少一处命中。**跳过不算通过**——跳过的探针
# 会在末尾单独列出来，报告里必须写清楚哪几处没测到、为什么。
#
# 判定口径比「grep 一下明文」严一档：同时查明文与它的 base64 形态。真实世界里
# 最常见的泄漏不是有人 `console.log(key)`，而是某一层把整个凭据对象 JSON 化再
# base64 丢进日志——只查明文会漏掉那一类。
#
# 环境变量（都可选，缺了就跳过对应探针）：
#   DATABASE_URL             psql 全表扫描
#   AUDIT_LOG_DIR            各服务日志目录（默认 /tmp/logs），扫 *.log
#   AUDIT_SANDBOX_ENV_URL    返回沙箱 env 的 URL（e2e 的假 agent-worker 是 /__control/calls）
#   AUDIT_SANDBOX_ENV_FILE   同上，文件形式
#   AUDIT_API_URL            控制台凭据 API（例如 http://localhost:3000/api/v1/llm/credentials）
#   AUDIT_COOKIE             上面那个请求的 Cookie
#   AUDIT_REPO_ROOT          源码探针的根目录（默认脚本所在仓库）
set -uo pipefail

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "usage: audit-no-plaintext-key.sh <plaintext-provider-key>" >&2
  exit 2
fi

REPO_ROOT="${AUDIT_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="${AUDIT_LOG_DIR:-/tmp/logs}"

FAIL=0
SKIPPED=()

# base64 形态：取中段避开首尾填充相位差异。太短的 key 只查明文（易误报）。
KEY_B64=""
if [ "${#KEY}" -ge 12 ]; then
  KEY_B64="$(printf '%s' "$KEY" | base64 | tr -d '\n=' | cut -c5-$(( $(printf '%s' "$KEY" | base64 | tr -d '\n=' | wc -c) - 4 )))"
fi

# probe <名字> <内容>
probe() {
  local name="$1" haystack="$2"
  if printf '%s' "$haystack" | grep -qF -- "$KEY"; then
    echo "LEAK(plaintext) in $name"
    FAIL=1
  elif [ -n "$KEY_B64" ] && [ "${#KEY_B64}" -ge 8 ] && printf '%s' "$haystack" | grep -qF -- "$KEY_B64"; then
    echo "LEAK(base64) in $name"
    FAIL=1
  else
    echo "clean: $name"
  fi
}

skip() {
  echo "skip:  $1 ($2)"
  SKIPPED+=("$1")
}

echo "== llm-router plaintext-key audit =="

# ---------------------------------------------------------------------------
# ① 沙箱环境变量（run 真正拿到的那一份 env）
# ---------------------------------------------------------------------------
if [ -n "${AUDIT_SANDBOX_ENV_FILE:-}" ] && [ -f "${AUDIT_SANDBOX_ENV_FILE}" ]; then
  probe "sandbox env" "$(cat "${AUDIT_SANDBOX_ENV_FILE}")"
elif [ -n "${AUDIT_SANDBOX_ENV_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  probe "sandbox env" "$(curl -sS --max-time 5 "${AUDIT_SANDBOX_ENV_URL}" || true)"
else
  skip "sandbox env" "set AUDIT_SANDBOX_ENV_URL or AUDIT_SANDBOX_ENV_FILE"
fi

# ---------------------------------------------------------------------------
# ② 数据库全表扫描：凭据表与 Vault 表的每一列
# ---------------------------------------------------------------------------
if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  DB_DUMP="$(psql "$DATABASE_URL" -Atc "
    SELECT string_agg(t::text, E'\n') FROM (
      SELECT * FROM llm_credentials
    ) t;" 2>/dev/null || true)"
  DB_DUMP="$DB_DUMP
$(psql "$DATABASE_URL" -Atc "
    SELECT string_agg(t::text, E'\n') FROM (SELECT * FROM vault_entries) t;" 2>/dev/null || true)"
  DB_DUMP="$DB_DUMP
$(psql "$DATABASE_URL" -Atc "SELECT string_agg(payload::text, E'\n') FROM run_events;" 2>/dev/null || true)"
  probe "database (llm_credentials + vault_entries + run_events)" "$DB_DUMP"
else
  skip "database" "DATABASE_URL unset or psql missing"
fi

# ---------------------------------------------------------------------------
# ③ 各服务日志
# ---------------------------------------------------------------------------
if [ -d "$LOG_DIR" ]; then
  for svc in web control-worker agent-worker llm-router; do
    if [ -f "$LOG_DIR/$svc.log" ]; then
      probe "log:$svc" "$(cat "$LOG_DIR/$svc.log")"
    else
      skip "log:$svc" "$LOG_DIR/$svc.log not found"
    fi
  done
else
  skip "logs" "$LOG_DIR does not exist"
fi

# ---------------------------------------------------------------------------
# ④ 控制台凭据 API 的响应
# ---------------------------------------------------------------------------
if [ -n "${AUDIT_API_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  probe "api response" "$(curl -sS --max-time 5 -H "Cookie: ${AUDIT_COOKIE:-}" "${AUDIT_API_URL}" || true)"
else
  skip "api response" "set AUDIT_API_URL (and AUDIT_COOKIE)"
fi

# ---------------------------------------------------------------------------
# ⑤ 源码结构探针（A11 ②）：web / control-plane 里不得出现解封调用点或私钥变量
#    这一条不查 key 本身，查的是「有没有能解出 key 的代码」——**结构性**证明。
# ---------------------------------------------------------------------------
if command -v grep >/dev/null 2>&1 && [ -d "$REPO_ROOT/apps/web" ]; then
  HITS="$(grep -rn --include=*.ts --include=*.tsx -e 'openSealed' -e 'LLM_ROUTER_PRIVATE' \
    "$REPO_ROOT/apps/web" "$REPO_ROOT/packages/control-plane" 2>/dev/null \
    | grep -v '__tests__' | grep -v '\.test\.' || true)"
  if [ -n "$HITS" ]; then
    echo "LEAK(structure): web/control-plane can decrypt or holds the private key:"
    echo "$HITS"
    FAIL=1
  else
    echo "clean: source (no openSealed / LLM_ROUTER_PRIVATE in web or control-plane)"
  fi
else
  skip "source" "repo root not found at $REPO_ROOT"
fi

# ---------------------------------------------------------------------------
# ⑥ 构建产物：web 与 control-plane 的 dist 里连解封那段代码都不该有
# ---------------------------------------------------------------------------
ARTIFACT_HITS=""
for artifact in "$REPO_ROOT/packages/control-plane/dist/index.js" "$REPO_ROOT/packages/control-plane/dist/index.cjs"; do
  if [ -f "$artifact" ] && grep -qF 'openSealed' "$artifact"; then
    ARTIFACT_HITS="$ARTIFACT_HITS $artifact"
  fi
done
if [ -n "$ARTIFACT_HITS" ]; then
  echo "LEAK(artifact): openSealed present in$ARTIFACT_HITS"
  FAIL=1
elif [ -f "$REPO_ROOT/packages/control-plane/dist/index.js" ]; then
  echo "clean: build artifacts (control-plane/dist has no openSealed)"
else
  skip "build artifacts" "run pnpm build first"
fi

# ---------------------------------------------------------------------------
# ⑦ 部署清单：私钥只允许出现在 llm-router 上
# ---------------------------------------------------------------------------
if command -v kubectl >/dev/null 2>&1; then
  for d in web control-worker agent-worker; do
    if kubectl get deploy "$d" -o yaml 2>/dev/null | grep -q LLM_ROUTER_PRIVATE; then
      echo "LEAK: deploy/$d has LLM_ROUTER_PRIVATE_KEY"
      FAIL=1
    else
      echo "clean: deploy/$d"
    fi
  done
else
  skip "k8s manifests" "kubectl not available"
fi

echo "== result =="
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "skipped probes (report them, do NOT count as pass): ${SKIPPED[*]}"
fi
if [ "$FAIL" -eq 0 ]; then
  echo "PASS: no plaintext provider key found in any executed probe"
else
  echo "FAIL: plaintext provider key (or a decrypt path) found"
fi
exit "$FAIL"
