import { describe, expect, it } from 'vitest';
import { makeCredential, makeRoute } from '../../../test/catalog-fixtures.js';
import { buildUpstreamHeaders, extractGroupingHints, stripHopByHop } from '../headers.js';

const REQ_ID = 'req-1-abc';

describe('buildUpstreamHeaders', () => {
  it('剥掉 hop-by-hop 头', () => {
    const out = buildUpstreamHeaders(
      new Headers({
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        trailer: 'x',
        'transfer-encoding': 'chunked',
        upgrade: 'h2c',
        'proxy-authorization': 'Basic x',
        'content-type': 'application/json',
      }),
      makeRoute({ credential: null }),
      null,
      REQ_ID
    );
    for (const h of [
      'connection',
      'keep-alive',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'proxy-authorization',
    ]) {
      expect(out.has(h)).toBe(false);
    }
    expect(out.get('content-type')).toBe('application/json');
  });

  it('剥掉调用方的 router 令牌（authorization / x-api-key）', () => {
    const out = buildUpstreamHeaders(
      new Headers({ authorization: 'Bearer rt_caller', 'x-api-key': 'rt_caller' }),
      makeRoute({ credential: null }),
      null,
      REQ_ID
    );
    expect(out.get('authorization')).toBeNull();
    expect(out.get('x-api-key')).toBeNull();
  });

  it('保留 anthropic-version / anthropic-beta 原值', () => {
    const out = buildUpstreamHeaders(
      new Headers({
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31,computer-use-2025-01-24',
      }),
      makeRoute({ credential: null }),
      null,
      REQ_ID
    );
    expect(out.get('anthropic-version')).toBe('2023-06-01');
    expect(out.get('anthropic-beta')).toBe('prompt-caching-2024-07-31,computer-use-2025-01-24');
  });

  it('★ 从未见过的 anthropic-* 头默认放行（证明没有白名单）', () => {
    const out = buildUpstreamHeaders(
      new Headers({
        'anthropic-beta': 'some-future-beta-2099-12-31',
        'anthropic-unheard-of-header': 'yes',
        'x-vendor-experimental': '1',
      }),
      makeRoute({ credential: null }),
      null,
      REQ_ID
    );
    expect(out.get('anthropic-beta')).toBe('some-future-beta-2099-12-31');
    expect(out.get('anthropic-unheard-of-header')).toBe('yes');
    expect(out.get('x-vendor-experimental')).toBe('1');
  });

  it('x-claude-code-* 被消费掉，不转发上游', () => {
    const out = buildUpstreamHeaders(
      new Headers({
        'x-claude-code-session-id': 's1',
        'x-claude-code-agent-id': 'a1',
        'x-claude-code-parent-agent-id': 'p1',
      }),
      makeRoute({ credential: null }),
      null,
      REQ_ID
    );
    expect(out.get('x-claude-code-session-id')).toBeNull();
    expect(out.get('x-claude-code-agent-id')).toBeNull();
    expect(out.get('x-claude-code-parent-agent-id')).toBeNull();
  });

  it('accept-encoding 强制 identity（调用方传了 gzip 也一样）', () => {
    const out = buildUpstreamHeaders(
      new Headers({ 'accept-encoding': 'gzip, br' }),
      makeRoute({ credential: null }),
      null,
      REQ_ID
    );
    expect(out.get('accept-encoding')).toBe('identity');
  });

  it('x-request-id 换成网关生成的那一个', () => {
    const out = buildUpstreamHeaders(
      new Headers({ 'x-request-id': 'caller-supplied' }),
      makeRoute({ credential: null }),
      null,
      REQ_ID
    );
    expect(out.get('x-request-id')).toBe(REQ_ID);
  });

  it('provider.defaultHeaders 覆盖同名的调用方头', () => {
    const out = buildUpstreamHeaders(
      new Headers({ 'x-tenant': 'from-caller', accept: 'application/json' }),
      makeRoute({ credential: null, provider: { defaultHeaders: { 'x-tenant': 'from-config' } } }),
      null,
      REQ_ID
    );
    expect(out.get('x-tenant')).toBe('from-config');
    expect(out.get('accept')).toBe('application/json');
  });

  describe('三种 authStyle 各注入正确的头', () => {
    it('bearer → Authorization: Bearer', () => {
      const out = buildUpstreamHeaders(
        new Headers(),
        makeRoute({ credential: makeCredential('sk-x', { authStyle: 'bearer' }) }),
        'sk-x',
        REQ_ID
      );
      expect(out.get('authorization')).toBe('Bearer sk-x');
      expect(out.get('x-api-key')).toBeNull();
    });

    it('x-api-key → x-api-key', () => {
      const out = buildUpstreamHeaders(
        new Headers(),
        makeRoute({ credential: makeCredential('sk-x', { authStyle: 'x-api-key' }) }),
        'sk-x',
        REQ_ID
      );
      expect(out.get('x-api-key')).toBe('sk-x');
      expect(out.get('authorization')).toBeNull();
    });

    it('header → 自定义头名', () => {
      const out = buildUpstreamHeaders(
        new Headers(),
        makeRoute({
          credential: makeCredential('sk-x', { authStyle: 'header', authHeader: 'x-goog-api-key' }),
        }),
        'sk-x',
        REQ_ID
      );
      expect(out.get('x-goog-api-key')).toBe('sk-x');
      expect(out.get('authorization')).toBeNull();
    });

    it('authStyle=header 但 authHeader 缺失 → 不注入任何认证头（不猜头名）', () => {
      const out = buildUpstreamHeaders(
        new Headers(),
        makeRoute({
          credential: makeCredential('sk-x', { authStyle: 'header', authHeader: null }),
        }),
        'sk-x',
        REQ_ID
      );
      expect(out.get('authorization')).toBeNull();
      expect(out.get('x-api-key')).toBeNull();
    });
  });

  it('provider 未绑定凭据时不注入认证头', () => {
    const out = buildUpstreamHeaders(new Headers(), makeRoute({ credential: null }), null, REQ_ID);
    expect(out.get('authorization')).toBeNull();
    expect(out.get('x-api-key')).toBeNull();
  });
});

describe('buildUpstreamHeaders · crossProtocol（T4.7）', () => {
  const inbound = new Headers({
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'context-management-2025-06-27,some-future-beta',
    'anthropic-workspace-id': 'ws-1',
    'x-custom': 'kept',
  });

  it('★ 跨协议时剥掉所有 anthropic-*（OpenAI 上游不认，严格实现会 400）', () => {
    const out = buildUpstreamHeaders(inbound, makeRoute({ credential: null }), null, REQ_ID, {
      crossProtocol: true,
    });
    expect(out.get('anthropic-version')).toBeNull();
    expect(out.get('anthropic-beta')).toBeNull();
    expect(out.get('anthropic-workspace-id')).toBeNull();
    // 非 Anthropic 专有的头照常按开放列表转发。
    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('x-custom')).toBe('kept');
    expect(out.get('accept-encoding')).toBe('identity');
  });

  it('默认（同协议）不剥：开放列表原则原封不动', () => {
    const out = buildUpstreamHeaders(inbound, makeRoute({ credential: null }), null, REQ_ID);
    expect(out.get('anthropic-beta')).toBe('context-management-2025-06-27,some-future-beta');
    expect(out.get('anthropic-version')).toBe('2023-06-01');
  });

  it('跨协议也照常按 authStyle 注入凭据', () => {
    const out = buildUpstreamHeaders(
      inbound,
      makeRoute({ credential: makeCredential('sk-openai', { authStyle: 'bearer' }) }),
      'sk-openai',
      REQ_ID,
      { crossProtocol: true }
    );
    expect(out.get('authorization')).toBe('Bearer sk-openai');
  });
});

describe('stripHopByHop', () => {
  it('剥掉响应侧的 hop-by-hop 头', () => {
    const out = stripHopByHop(
      new Headers({
        connection: 'close',
        'transfer-encoding': 'chunked',
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-requests-remaining': '99',
      })
    );
    expect(out.get('connection')).toBeNull();
    expect(out.get('transfer-encoding')).toBeNull();
    expect(out.get('content-type')).toBe('text/event-stream');
    // 上游的限流提示头要留给调用方
    expect(out.get('anthropic-ratelimit-requests-remaining')).toBe('99');
  });

  it('★ 剥掉 content-encoding（undici 已经解压过，头再说 gzip 客户端会解第二次）', () => {
    const out = stripHopByHop(
      new Headers({ 'content-encoding': 'gzip', 'content-type': 'application/json' })
    );
    expect(out.get('content-encoding')).toBeNull();
    expect(out.get('content-type')).toBe('application/json');
  });

  it('上游回显 authorization / x-api-key 时也被剥掉（防密钥回显）', () => {
    const out = stripHopByHop(
      new Headers({ authorization: 'Bearer sk-upstream', 'x-api-key': 'sk-upstream' })
    );
    expect(out.get('authorization')).toBeNull();
    expect(out.get('x-api-key')).toBeNull();
  });
});

describe('extractGroupingHints', () => {
  it('取出两个 cc_* 分组提示', () => {
    expect(
      extractGroupingHints(
        new Headers({ 'x-claude-code-session-id': 's1', 'x-claude-code-agent-id': 'a1' })
      )
    ).toEqual({ ccSessionId: 's1', ccAgentId: 'a1' });
  });

  it('缺头时为 null', () => {
    expect(extractGroupingHints(new Headers())).toEqual({ ccSessionId: null, ccAgentId: null });
  });
});
