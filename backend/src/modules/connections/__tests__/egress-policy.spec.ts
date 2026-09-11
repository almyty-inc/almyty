import { EgressNotAllowedError, assertEgressAllowed, decideEgress, hostMatches } from '../egress-policy';

/**
 * L1 gate: a base URL outside the allowlist is refused.
 *
 * Every generic provider in L2 takes a user-supplied URL, so this gate
 * sits under all of them. It replaces two install-wide environment flags
 * whose only setting was "every private range, for every organization".
 */
describe('egress policy', () => {
  it('allows an ordinary public endpoint', () => {
    expect(decideEgress('https://api.openai.com/v1')).toEqual({ allowed: true });
    expect(decideEgress('https://vllm.acme.com:8000/v1')).toEqual({ allowed: true });
  });

  it('refuses a private, loopback or link-local host by default', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8000/v1',
      'http://10.0.0.5/v1',
      'http://192.168.1.20:8080/v1',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      const decision = decideEgress(url);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/private or loopback|not a valid URL/);
    }
  });

  it('names the host and says what to do about it, rather than failing blankly', () => {
    const decision = decideEgress('http://192.168.1.20:8080/v1');
    expect(decision.reason).toContain('192.168.1.20');
    expect(decision.reason).toContain('egress allowlist');
  });

  it('reaches a private host only when that host is allowlisted', () => {
    // A literal private address, because a hostname is not known to be
    // private until it resolves: that is caught at request time by the
    // DNS-pinning agent, not by this static gate.
    const policy = { allowlist: ['10.0.0.9'] };
    expect(decideEgress('http://10.0.0.9:8000/v1', policy)).toMatchObject({ allowed: true, viaAllowlist: true });
    // A different private host is still refused: the allowlist is per host,
    // not a switch that opens the range.
    expect(decideEgress('http://192.168.1.20:8080/v1', policy).allowed).toBe(false);
    expect(decideEgress('http://127.0.0.1/v1', policy).allowed).toBe(false);
  });

  it('supports a wildcard for one subtree without opening its parent', () => {
    expect(hostMatches('a.internal.example', '*.internal.example')).toBe(true);
    expect(hostMatches('a.b.internal.example', '*.internal.example')).toBe(true);
    expect(hostMatches('internal.example', '*.internal.example')).toBe(false);
    expect(hostMatches('evil-internal.example', '*.internal.example')).toBe(false);
  });

  it('matches hosts case-insensitively and ignores padding', () => {
    expect(hostMatches('VLLM.Internal', ' vllm.internal ')).toBe(true);
    expect(hostMatches('vllm.internal', '')).toBe(false);
  });

  it('does not let the allowlist smuggle past the other checks', () => {
    const policy = { allowlist: ['localhost', '127.0.0.1'] };
    // Still not an HTTP(S) URL, and still not a URL at all.
    expect(decideEgress('file:///etc/passwd', policy).allowed).toBe(false);
    expect(decideEgress('ftp://localhost/x', policy).allowed).toBe(false);
    expect(decideEgress('not a url', policy).allowed).toBe(false);
  });

  it('throws a typed error carrying the URL, so a caller can say which one', () => {
    expect(() => assertEgressAllowed('https://api.openai.com/v1')).not.toThrow();
    try {
      assertEgressAllowed('http://10.0.0.5/v1');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(EgressNotAllowedError);
      expect((err as EgressNotAllowedError).code).toBe('EGRESS_NOT_ALLOWED');
      expect((err as EgressNotAllowedError).url).toBe('http://10.0.0.5/v1');
    }
  });
});
