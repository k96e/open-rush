import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPortFree, writePrivateKeyFile } from '../lib/router-process.js';

describe('assertPortFree', () => {
  let occupied: Server | null = null;
  afterEach(() => {
    occupied?.close();
    occupied = null;
  });

  it('空闲端口直接通过，并且不留下监听', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const p = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(p));
      });
    });
    await expect(assertPortFree(port)).resolves.toBeUndefined();
    // 通过之后端口仍是空闲的——探测用的 server 已经关掉了
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });

  it('端口被占时抛错，并把「上一轮遗留的副本」这条线索写进消息里', async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      occupied = server;
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    await expect(assertPortFree(port)).rejects.toThrow(/already in use/);
    await expect(assertPortFree(port)).rejects.toThrow(/previous run/);
  });
});

describe('writePrivateKeyFile', () => {
  it('内容逐字写入，权限 0600 —— env 里只放路径，与生产一致', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMC4CAQAw\n-----END PRIVATE KEY-----\n';
    const file = writePrivateKeyFile(pem);
    expect(readFileSync(file, 'utf8')).toBe(pem);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('每次调用落在不同的临时目录，互不覆盖', () => {
    const a = writePrivateKeyFile('a');
    const b = writePrivateKeyFile('b');
    expect(a).not.toBe(b);
    expect(readFileSync(a, 'utf8')).toBe('a');
    expect(readFileSync(b, 'utf8')).toBe('b');
  });
});
