import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  trustedClientIp,
  trustedProxyHops,
} from '../client-ip';

/**
 * The per-IP rate limit on the anonymous chat surfaces is keyed on this
 * value. If a caller can choose it, they can mint a fresh counter per
 * request — and those surfaces start an LLM run on the tenant's own
 * provider keys. So the property under test is not "which IP do we
 * report" but "can the caller pick it".
 */
describe('trustedClientIp', () => {
  const req = (xff?: string | string[], ip = '10.0.0.1') => ({
    ip,
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

  it('ignores a hop the caller prepended and takes the one our proxy appended', () => {
    // The whole defect in one line. Old behaviour returned '1.2.3.4'.
    expect(trustedClientIp(req('1.2.3.4, 203.0.113.9'), 1)).toBe('203.0.113.9');
  });

  it('gives a caller who rotates the forged hop the same key every time', () => {
    const first = trustedClientIp(req('9.9.9.1, 203.0.113.9'), 1);
    const second = trustedClientIp(req('9.9.9.2, 203.0.113.9'), 1);
    const third = trustedClientIp(req('not-even-an-ip, 203.0.113.9'), 1);

    expect(new Set([first, second, third]).size).toBe(1);
    expect(first).toBe('203.0.113.9');
  });

  it('counts hops from the right when more than one trusted proxy appends', () => {
    // client, CDN, ingress -> the client's real address is 2 from the right.
    expect(trustedClientIp(req('forged, 198.51.100.7, 203.0.113.9'), 2)).toBe('198.51.100.7');
  });

  it('handles the single-entry chain an overwriting proxy produces', () => {
    expect(trustedClientIp(req('203.0.113.9'), 1)).toBe('203.0.113.9');
  });

  it('clamps rather than reading past the end of a short chain', () => {
    // Configured for 3 hops but only 1 arrived: merge onto the leftmost
    // real entry. Merging throttles harder, never softer.
    expect(trustedClientIp(req('203.0.113.9'), 3)).toBe('203.0.113.9');
  });

  it('joins a repeated header rather than trusting only the first instance', () => {
    expect(trustedClientIp(req(['forged', '203.0.113.9']), 1)).toBe('203.0.113.9');
  });

  it('tolerates whitespace and empty entries in the chain', () => {
    expect(trustedClientIp(req('  forged ,, ,  203.0.113.9  '), 1)).toBe('203.0.113.9');
  });

  it('falls back to the socket address when there is no header at all', () => {
    expect(trustedClientIp(req(undefined, '198.51.100.20'), 1)).toBe('198.51.100.20');
  });

  it('falls back to the socket address when the header is present but empty', () => {
    expect(trustedClientIp({ ip: '198.51.100.20', headers: { 'x-forwarded-for': '' } }, 1)).toBe(
      '198.51.100.20',
    );
  });

  it('reports undefined rather than a guess when nothing is knowable', () => {
    // A fabricated key would look like a control and not be one; the
    // limiter skips a scope whose id is absent, which is honest.
    expect(trustedClientIp({ headers: {} }, 1)).toBeUndefined();
  });
});

describe('trustedProxyHops', () => {
  it('defaults to a single ingress', () => {
    expect(trustedProxyHops({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
  });

  it('reads the configured hop count', () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' } as any)).toBe(2);
  });

  it('refuses a value that would disable the check', () => {
    // 0 would index past the right edge and hand the caller the
    // leftmost entry back — the original defect, via config.
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '0' } as any)).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '-3' } as any)).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: 'lots' } as any)).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
  });
});
