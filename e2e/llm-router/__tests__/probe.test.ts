import { describe, expect, it } from 'vitest';
import { allClean, excerptAround, probeForSecret, renderProbes } from '../lib/probe.js';

const SECRET = 'sk-ant-ACCEPTANCE-PLAINTEXT-0123456789abcdef';

describe('probeForSecret', () => {
  it('干净的输入判 none', () => {
    const r = probeForSecret('log', 'nothing to see here', SECRET);
    expect(r).toEqual({ name: 'log', leaked: false, form: 'none' });
  });

  it('命中明文', () => {
    const r = probeForSecret('log', `oops key=${SECRET} tail`, SECRET);
    expect(r.leaked).toBe(true);
    expect(r.form).toBe('plaintext');
  });

  it('命中 base64 形态 —— 只 grep 明文会漏掉的那一类', () => {
    const encoded = Buffer.from(SECRET, 'utf8').toString('base64');
    const r = probeForSecret('log', `{"blob":"${encoded}"}`, SECRET);
    expect(r.leaked).toBe(true);
    expect(r.form).toBe('base64');
  });

  it('base64 的三种对齐相位都能命中（密钥被夹在别的内容中间时）', () => {
    const encoded = Buffer.from(`xx${SECRET}`, 'utf8').toString('base64');
    expect(probeForSecret('log', encoded, SECRET).leaked).toBe(true);
  });

  it('excerpt 里把密钥本身抹成 <REDACTED>，报告可以原样贴', () => {
    const r = probeForSecret('log', `before ${SECRET} after`, SECRET);
    expect(r.excerpt).toContain('<REDACTED>');
    expect(r.excerpt).not.toContain(SECRET);
  });

  it('短密钥只查明文，不做 base64 探测（避免误报）', () => {
    const short = 'abc';
    const encoded = Buffer.from(short, 'utf8').toString('base64');
    expect(probeForSecret('log', encoded, short).leaked).toBe(false);
  });

  it('空密钥是调用方的错误，直接抛 —— 否则会「全部 clean」地假通过', () => {
    expect(() => probeForSecret('log', 'anything', '')).toThrow(/must not be empty/);
  });
});

describe('excerptAround', () => {
  it('截取命中处前后各 40 字符并压平空白', () => {
    const hay = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`;
    const out = excerptAround(hay, 100, 'NEEDLE');
    expect(out).toBe(`${'a'.repeat(40)}<REDACTED>${'b'.repeat(40)}`);
  });

  it('命中在开头/结尾时不越界', () => {
    expect(excerptAround('NEEDLEtail', 0, 'NEEDLE')).toBe('<REDACTED>tail');
    expect(excerptAround('headNEEDLE', 4, 'NEEDLE')).toBe('head<REDACTED>');
  });
});

describe('allClean / renderProbes', () => {
  it('有一处泄漏就不 clean', () => {
    const results = [probeForSecret('a', 'clean', SECRET), probeForSecret('b', SECRET, SECRET)];
    expect(allClean(results)).toBe(false);
    expect(allClean([results[0]])).toBe(true);
  });

  it('渲染出的行区分 clean 与 LEAK，并标出形态', () => {
    const lines = renderProbes([
      probeForSecret('a', 'clean', SECRET),
      probeForSecret('b', SECRET, SECRET),
    ]);
    expect(lines[0]).toBe('clean: a');
    expect(lines[1]).toMatch(/^LEAK\(plaintext\) in b:/);
  });
});
