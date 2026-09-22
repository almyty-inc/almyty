import {
  decideToolRequest,
  domainMatches,
  effectiveMaxResponseBytes,
  assertToolRequestAllowed,
  ToolPolicyViolationError,
} from '../gateway-tool-policy';

/**
 * Unit coverage for the `gateway_tools.securityPolicy` decision function.
 *
 * Note what this file deliberately does NOT prove: that anything calls it.
 * The bug being fixed here was a policy with a column, a PATCH endpoint and
 * a dashboard form and no reader, and a file like this one would have passed
 * against that code just as happily. The wiring is proved by
 * `modules/tools/__tests__/security-policy-is-enforced.guard.spec.ts`.
 */
describe('domainMatches', () => {
  it('matches the exact host', () => {
    expect(domainMatches('api.example.com', 'api.example.com')).toBe(true);
  });

  it('matches a subdomain of a bare pattern', () => {
    expect(domainMatches('admin.internal.corp', 'internal.corp')).toBe(true);
  });

  it('does not match a different host that merely ends in the same letters', () => {
    expect(domainMatches('notexample.com', 'example.com')).toBe(false);
    expect(domainMatches('evil-example.com', 'example.com')).toBe(false);
  });

  it('is case-insensitive and ignores a trailing root dot', () => {
    expect(domainMatches('API.Example.COM.', 'api.example.com')).toBe(true);
  });

  it('honours an explicit *. pattern as subdomains only', () => {
    expect(domainMatches('a.example.com', '*.example.com')).toBe(true);
    expect(domainMatches('example.com', '*.example.com')).toBe(false);
  });

  it('never matches on an empty host or pattern', () => {
    expect(domainMatches('', 'example.com')).toBe(false);
    expect(domainMatches('example.com', '   ')).toBe(false);
  });
});

describe('decideToolRequest', () => {
  it('allows everything when there is no policy', () => {
    expect(decideToolRequest(null, 'http://anything.example.com', 'DELETE').allowed).toBe(true);
    expect(decideToolRequest(undefined, 'http://anything.example.com').allowed).toBe(true);
  });

  it('allows everything when the policy is empty', () => {
    expect(decideToolRequest({}, 'http://anything.example.com', 'DELETE').allowed).toBe(true);
  });

  it('refuses a host that is not on the allowed list', () => {
    const d = decideToolRequest(
      { allowedDomains: ['api.example.com'] },
      'https://evil.example.org/x',
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('allowed-domain list');
  });

  it('allows a host that is on the allowed list', () => {
    expect(
      decideToolRequest({ allowedDomains: ['api.example.com'] }, 'https://api.example.com/x')
        .allowed,
    ).toBe(true);
  });

  it('refuses a blocked host even when it is also allow-listed', () => {
    const d = decideToolRequest(
      { allowedDomains: ['example.com'], blockedDomains: ['admin.example.com'] },
      'https://admin.example.com/x',
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('blocked-domain list');
  });

  it('refuses plain http when requireHttps is set', () => {
    const d = decideToolRequest({ requireHttps: true }, 'http://api.example.com/x');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('HTTPS');
    expect(decideToolRequest({ requireHttps: true }, 'https://api.example.com/x').allowed).toBe(
      true,
    );
  });

  it('refuses a method that is not on the allowed list, case-insensitively', () => {
    const policy = { allowedHttpMethods: ['GET', 'post'] };
    expect(decideToolRequest(policy, 'https://api.example.com/x', 'DELETE').allowed).toBe(false);
    expect(decideToolRequest(policy, 'https://api.example.com/x', 'get').allowed).toBe(true);
    expect(decideToolRequest(policy, 'https://api.example.com/x', 'POST').allowed).toBe(true);
  });

  it('refuses a URL it cannot parse rather than waving it through', () => {
    expect(decideToolRequest({ requireHttps: true }, 'not a url').allowed).toBe(false);
  });
});

describe('effectiveMaxResponseBytes', () => {
  it('returns the executor default when the policy sets nothing', () => {
    expect(effectiveMaxResponseBytes(null, 1000)).toBe(1000);
    expect(effectiveMaxResponseBytes({}, 1000)).toBe(1000);
  });

  it('tightens the default', () => {
    expect(effectiveMaxResponseBytes({ maxResponseSizeBytes: 250 }, 1000)).toBe(250);
  });

  it('never raises the default', () => {
    expect(effectiveMaxResponseBytes({ maxResponseSizeBytes: 99999 }, 1000)).toBe(1000);
  });

  it('ignores zero, negative and non-finite values', () => {
    expect(effectiveMaxResponseBytes({ maxResponseSizeBytes: 0 }, 1000)).toBe(1000);
    expect(effectiveMaxResponseBytes({ maxResponseSizeBytes: -5 }, 1000)).toBe(1000);
    expect(effectiveMaxResponseBytes({ maxResponseSizeBytes: NaN }, 1000)).toBe(1000);
  });
});

describe('assertToolRequestAllowed', () => {
  it('throws a typed error carrying the URL and the reason', () => {
    expect(() =>
      assertToolRequestAllowed({ allowedDomains: ['a.example.com'] }, 'https://b.example.com/x'),
    ).toThrow(ToolPolicyViolationError);

    try {
      assertToolRequestAllowed({ allowedDomains: ['a.example.com'] }, 'https://b.example.com/x');
      throw new Error('should not reach');
    } catch (e: any) {
      expect(e.code).toBe('TOOL_POLICY_VIOLATION');
      expect(e.url).toBe('https://b.example.com/x');
    }
  });

  it('is silent when the policy permits', () => {
    expect(() => assertToolRequestAllowed(null, 'https://b.example.com/x')).not.toThrow();
  });
});
