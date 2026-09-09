/**
 * 生成 llm-router 的 X25519 密钥对（M2·T2.2）。
 *
 *   pnpm llm:keygen
 *
 * 输出两段 PEM 与公钥指纹 keyId。**两边不要都配**：
 *   - 公钥 `LLM_ROUTER_PUBLIC_KEY`  → apps/web（只能 seal，物理上无法 open）
 *   - 私钥 `LLM_ROUTER_PRIVATE_KEY` → apps/llm-router（唯一能 open 的进程）
 *
 * 私钥落盘时优先用 `LLM_ROUTER_PRIVATE_KEY_FILE` 指向挂载的 Secret 文件；
 * inline 变量只建议用于本地开发。
 *
 * 脚本**不写任何文件、不落日志**——输出只走 stdout，由人转移进密钥管理系统。
 */
import { resolve } from 'node:path';
import { generateRouterKeyPair } from '@open-rush/llm-router';

export interface RouterKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
}

const b64 = (pem: string): string => Buffer.from(pem, 'utf8').toString('base64');

/**
 * 渲染可直接粘进 `.env.local` / Secret 的使用提示。
 *
 * 纯函数，便于单测断言「公钥段没有混进私钥」这类硬要求。
 */
export function renderRouterKeypair(pair: RouterKeyPair): string {
  const { publicKeyPem, privateKeyPem, keyId } = pair;
  return `# llm-router keypair — keyId ${keyId}

# ---------------------------------------------------------------------------
# 1) 公钥 → apps/web。web 只能 seal，物理上无法 open。
# ---------------------------------------------------------------------------
${publicKeyPem.trim()}

# apps/web/.env.local（单行 base64 形式，seal 侧两种写法都接受）
LLM_ROUTER_PUBLIC_KEY=${b64(publicKeyPem)}

# ---------------------------------------------------------------------------
# 2) 私钥 → apps/llm-router 独占。除该服务外，任何进程的 env 都不得出现它。
# ---------------------------------------------------------------------------
${privateKeyPem.trim()}

# 推荐：挂载成文件，env 里只放路径
LLM_ROUTER_PRIVATE_KEY_FILE=/etc/open-rush/llm-router.key
# 本地开发退路（单行 base64 形式）
LLM_ROUTER_PRIVATE_KEY=${b64(privateKeyPem)}

# 部署后自证私钥没有发给别人（应为空）：
#   kubectl get deploy web control-worker -o yaml | grep -i LLM_ROUTER_PRIVATE
`;
}

/**
 * 是否被直接执行（而非被测试 import）。node/tsx 跑 TS 入口时 `argv[1]` 是脚本
 * 路径，与 `import.meta.url` 比对即可。与 validate-openapi.ts 同款。
 */
function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  return import.meta.url === new URL(`file://${resolve(scriptPath)}`).href;
}

if (isMainModule()) {
  process.stdout.write(renderRouterKeypair(generateRouterKeyPair()));
}
