/**
 * 堆快照对照实验的「对照组」（M7·T7.1，A11 ③）。
 *
 *   npx tsx e2e/llm-router/lib/heap-probe-peer.ts <credentialId> <plaintext>
 *
 * 它复现 **apps/web 侧的完整代码路径**——从库里读出凭据密文、`import` 封装侧的
 * 子路径入口、用公钥 seal 一条新的——然后给自己拍一张堆快照，grep 明文。
 *
 * 与网关进程唯一的差别：**env 里没有私钥**。所以它手上明明有密文，堆里也应该
 * 一个字节的明文都没有。这一对照比任何代码审查都有力：证明的不是「我们约定不解」，
 * 而是「没有私钥就解不了」（D3 的非对称设计）。
 *
 * 输出一行 JSON：`{"snapshotPath":"…","hasCiphertext":true,"sealingExports":[…]}`。
 * **不在这里 grep 明文**——明文若作为参数传进来就会以 argv 字符串活在堆里，
 * 快照必然命中，而那与「能不能解封」毫无关系。grep 由调用方做。
 * `snapshotPath` 为 null 表示快照没拍出来（环境不支持 `--heapsnapshot-signal`）。
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { closeDbClient, getDbClient, llmCredentials } from '@open-rush/db';
// 与 apps/web 完全相同的导入面：只有封装侧，模块图里物理上没有解封代码。
import * as sealing from '@open-rush/llm-router/sealing';
import { eq } from 'drizzle-orm';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const credentialId = process.argv[2];
  if (!credentialId) {
    process.stdout.write(`${JSON.stringify({ snapshotPath: null, hasCiphertext: false })}\n`);
    return;
  }

  const db = getDbClient();
  const [row] = await db.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId));
  // 密文留在作用域里，保证它在拍快照的那一刻确实活在堆上。
  const ciphertext = row?.sealedValue ?? '';

  // web 侧唯一会做的密码学操作：用公钥再 seal 一条。
  const publicKeyRaw = process.env.LLM_ROUTER_PUBLIC_KEY ?? '';
  const publicKeyPem = publicKeyRaw.includes('BEGIN')
    ? publicKeyRaw
    : Buffer.from(publicKeyRaw, 'base64').toString('utf8');
  const resealed = publicKeyPem ? sealing.seal(publicKeyPem, 'a-different-secret-value').value : '';

  process.kill(process.pid, 'SIGUSR2');
  await sleep(3_000);

  // 只报路径，**不在这里 grep**：明文一旦作为参数进到本进程，就会以 argv
  // 字符串的形式活在堆里，快照必然命中——那种命中与「能不能解封」无关。
  let snapshotPath: string | null = null;
  try {
    const listed = execFileSync('bash', ['-lc', 'ls -t ./*.heapsnapshot 2>/dev/null | head -1'], {
      encoding: 'utf8',
    }).trim();
    snapshotPath = listed ? resolve(listed) : null;
  } catch {
    snapshotPath = null;
  }

  await closeDbClient();
  process.stdout.write(
    `${JSON.stringify({
      snapshotPath,
      hasCiphertext: ciphertext.length > 0,
      resealedLength: resealed.length,
      // 这个入口的**全部**导出面。里面没有 openSealed 不是靠 tree-shaking 侥幸，
      // 是 `sealing.ts` 的模块图里根本没有 `crypto/open-sealed.ts`。
      sealingExports: Object.keys(sealing).sort(),
      privateKeyEnvEmpty:
        !process.env.LLM_ROUTER_PRIVATE_KEY && !process.env.LLM_ROUTER_PRIVATE_KEY_FILE,
    })}\n`
  );
}

void main();
