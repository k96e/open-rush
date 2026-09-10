/**
 * Tests for scripts/audit-no-plaintext-key.sh (M7·T7.3, A9 / A11 ②).
 *
 * 这个脚本是「切换到网关之后的门禁」，所以断言的重点只有两条：
 *   1. **真泄漏一定要红**（明文与 base64 两种形态）；
 *   2. **跳过不能被当成通过**——探针跳过时必须在输出里点名，否则一个
 *      「什么都没测」的运行会长得和「全部 clean」一模一样。
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'audit-no-plaintext-key.sh');
const KEY = 'sk-ant-AUDIT-TEST-PLAINTEXT-0123456789';

const dirs: string[] = [];
function tempLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
}

async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout } = await execFileAsync('bash', [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AUDIT_REPO_ROOT: REPO_ROOT,
        ...env,
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '' };
  }
}

describe('audit-no-plaintext-key.sh', () => {
  it('缺少密钥参数时回 2（用法错误），不是 0 也不是 1', async () => {
    const { code } = await run([]);
    expect(code).toBe(2);
  });

  it('日志干净时 PASS，退出码 0', async () => {
    const logs = tempLogDir();
    writeFileSync(join(logs, 'llm-router.log'), 'nothing sensitive here\n');
    const { code, stdout } = await run([KEY], { AUDIT_LOG_DIR: logs });
    expect(stdout).toContain('clean: log:llm-router');
    expect(stdout).toContain('PASS');
    expect(code).toBe(0);
  });

  it('日志里出现明文时 FAIL，退出码 1', async () => {
    const logs = tempLogDir();
    writeFileSync(join(logs, 'web.log'), `oops authorization=Bearer ${KEY}\n`);
    const { code, stdout } = await run([KEY], { AUDIT_LOG_DIR: logs });
    expect(stdout).toContain('LEAK(plaintext) in log:web');
    expect(stdout).toContain('FAIL');
    expect(code).toBe(1);
  });

  it('日志里出现 base64 形态时同样 FAIL —— 只 grep 明文会漏掉的那一类', async () => {
    const logs = tempLogDir();
    const encoded = Buffer.from(KEY, 'utf8').toString('base64');
    writeFileSync(join(logs, 'agent-worker.log'), `{"env":"${encoded}"}\n`);
    const { code, stdout } = await run([KEY], { AUDIT_LOG_DIR: logs });
    expect(stdout).toContain('LEAK(base64) in log:agent-worker');
    expect(code).toBe(1);
  });

  it('沙箱 env 文件里的明文会被抓到', async () => {
    const logs = tempLogDir();
    const envFile = join(logs, 'sandbox-env.json');
    writeFileSync(envFile, JSON.stringify({ ANTHROPIC_API_KEY: KEY }));
    const { code, stdout } = await run([KEY], {
      AUDIT_LOG_DIR: logs,
      AUDIT_SANDBOX_ENV_FILE: envFile,
    });
    expect(stdout).toContain('LEAK(plaintext) in sandbox env');
    expect(code).toBe(1);
  });

  it('只装了网关令牌的沙箱 env 是 clean 的', async () => {
    const logs = tempLogDir();
    const envFile = join(logs, 'sandbox-env.json');
    writeFileSync(
      envFile,
      JSON.stringify({
        ANTHROPIC_BASE_URL: 'http://llm-router:8790',
        ANTHROPIC_AUTH_TOKEN: 'rt_abc',
      })
    );
    const { code, stdout } = await run([KEY], {
      AUDIT_LOG_DIR: logs,
      AUDIT_SANDBOX_ENV_FILE: envFile,
    });
    expect(stdout).toContain('clean: sandbox env');
    expect(code).toBe(0);
  });

  it('探针跳过时会被点名 —— 「跳过」不等于「通过」', async () => {
    const { stdout, code } = await run([KEY], { AUDIT_LOG_DIR: join(tempLogDir(), 'missing') });
    expect(stdout).toContain('skipped probes (report them, do NOT count as pass):');
    expect(stdout).toContain('sandbox env');
    expect(code).toBe(0);
  });

  it('源码结构探针在本仓库上是 clean 的：web / control-plane 里没有解封路径', async () => {
    const { stdout } = await run([KEY], { AUDIT_LOG_DIR: tempLogDir() });
    expect(stdout).toContain(
      'clean: source (no openSealed / LLM_ROUTER_PRIVATE in web or control-plane)'
    );
  });

  it('把解封调用点种进 web 目录后，结构探针立刻变红', async () => {
    const fakeRepo = tempLogDir();
    const webDir = join(fakeRepo, 'apps', 'web');
    const cpDir = join(fakeRepo, 'packages', 'control-plane');
    for (const dir of [webDir, cpDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(webDir, 'leak.ts'), "import { openSealed } from '@open-rush/llm-router';\n");
    const { code, stdout } = await run([KEY], {
      AUDIT_REPO_ROOT: fakeRepo,
      AUDIT_LOG_DIR: tempLogDir(),
    });
    expect(stdout).toContain('LEAK(structure)');
    expect(code).toBe(1);
  });
});
