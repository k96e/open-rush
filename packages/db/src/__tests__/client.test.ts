import { afterEach, describe, expect, it } from 'vitest';
import { createNotificationListener, formatDatabaseUrlForLog, parsePoolMax } from '../client.js';

describe('parsePoolMax', () => {
  it('returns 10 for undefined', () => {
    expect(parsePoolMax(undefined)).toBe(10);
  });

  it('returns 10 for empty string', () => {
    expect(parsePoolMax('')).toBe(10);
  });

  it('parses valid number', () => {
    expect(parsePoolMax('20')).toBe(20);
  });

  it('caps at 100', () => {
    expect(parsePoolMax('200')).toBe(100);
  });

  it('returns 10 for NaN', () => {
    expect(parsePoolMax('abc')).toBe(10);
  });

  it('returns 10 for zero', () => {
    expect(parsePoolMax('0')).toBe(10);
  });

  it('returns 10 for negative', () => {
    expect(parsePoolMax('-5')).toBe(10);
  });
});

describe('formatDatabaseUrlForLog', () => {
  it('masks password in standard URL', () => {
    const result = formatDatabaseUrlForLog('postgresql://rush:secret@localhost:5432/rush');
    expect(result).toContain('***');
    expect(result).not.toContain('secret');
  });

  it('handles URL without password', () => {
    const result = formatDatabaseUrlForLog('postgresql://localhost:5432/rush');
    expect(result).toContain('localhost');
  });

  it('handles malformed URL gracefully', () => {
    const result = formatDatabaseUrlForLog('not-a-url');
    expect(result).toBe('not-a-url');
  });
});

describe('createNotificationListener', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  });

  it('throws when neither an argument nor DATABASE_URL is available', () => {
    delete process.env.DATABASE_URL;
    expect(() => createNotificationListener()).toThrow(/DATABASE_URL is not set/);
  });

  it('falls back to DATABASE_URL when no argument is given', async () => {
    process.env.DATABASE_URL = 'postgresql://rush:rush@localhost:5432/rush';
    const listener = createNotificationListener();
    expect(listener).toBeDefined();
    await listener.close();
  });

  it('constructs lazily — no connection is opened before listen()', async () => {
    // 指向一个不可能有人在听的端口：若构造时就建连，这里会挂或抛。
    const listener = createNotificationListener('postgresql://rush:rush@127.0.0.1:1/rush');
    expect(typeof listener.listen).toBe('function');
    await listener.close();
  });

  it('close() is idempotent', async () => {
    const listener = createNotificationListener('postgresql://rush:rush@127.0.0.1:1/rush');
    await listener.close();
    await expect(listener.close()).resolves.toBeUndefined();
    await expect(listener.close()).resolves.toBeUndefined();
  });

  it('refuses to listen after close', async () => {
    const listener = createNotificationListener('postgresql://rush:rush@127.0.0.1:1/rush');
    await listener.close();
    await expect(listener.listen('llm_catalog', () => {})).rejects.toThrow(
      /NotificationListener is closed/
    );
  });
});
