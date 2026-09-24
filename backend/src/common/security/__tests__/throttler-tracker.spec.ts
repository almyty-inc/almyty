import { UNIDENTIFIED_CLIENT_TRACKER, throttlerTracker } from '../throttler-tracker';

/**
 * The global ThrottlerGuard buckets on this string. Keyed wrong it is a
 * platform-wide outage switch: with `req.ip` behind an ingress every
 * request in the fleet shares one counter, so RATE_LIMIT_MAX=100 means
 * 100 requests a minute for all users and all tenants combined. Keyed
 * on something the caller writes it is not a limit at all.
 *
 * So the properties under test are: distinct clients get distinct keys,
 * one client gets one key no matter what they send, and there is always
 * a key.
 */
describe('throttlerTracker', () => {
  const req = (xff?: string | string[], ip = '10.42.0.7') => ({
    ip,
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

  describe('two clients behind the same proxy', () => {
    it('gives them different buckets', () => {
      // Both arrive at the same ingress pod, so req.ip is 10.42.0.7 for
      // both. This is the defect: the old tracker returned that address
      // and merged the entire platform into one counter.
      const alice = throttlerTracker(req('198.51.100.4'), 1);
      const bob = throttlerTracker(req('203.0.113.77'), 1);

      expect(alice).not.toBe(bob);
      expect(alice).toBe('ip:198.51.100.4');
      expect(bob).toBe('ip:203.0.113.77');
    });

    it('does not key on the proxy address that both requests share', () => {
      expect(throttlerTracker(req('198.51.100.4'), 1)).not.toContain('10.42.0.7');
    });
  });

  describe('a caller trying to choose their own bucket', () => {
    it('ignores a hop the caller prepended', () => {
      // The caller sends X-Forwarded-For: 1.2.3.4; nginx appends the
      // address it saw. Counting from the right discards the forgery.
      expect(throttlerTracker(req('1.2.3.4, 203.0.113.77'), 1)).toBe('ip:203.0.113.77');
    });

    it('gives the same bucket however many hops the caller invents', () => {
      const keys = [
        throttlerTracker(req('9.9.9.1, 203.0.113.77'), 1),
        throttlerTracker(req('9.9.9.2, 9.9.9.3, 203.0.113.77'), 1),
        throttlerTracker(req('a, b, c, d, e, f, g, 203.0.113.77'), 1),
        throttlerTracker(req(['forged', '203.0.113.77']), 1),
      ];

      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe('ip:203.0.113.77');
    });

    it('cannot be talked into the unidentified bucket by a forged hop', () => {
      // The sentinel is unprefixed and every real key is prefixed, so
      // spelling the sentinel into the header cannot collide with it.
      expect(throttlerTracker(req(`${UNIDENTIFIED_CLIENT_TRACKER}, 203.0.113.77`), 1)).toBe(
        'ip:203.0.113.77',
      );
    });

    it('still counts from the right with two trusted proxies in front', () => {
      // client, CDN, ingress: the client is 2 from the right.
      expect(throttlerTracker(req('forged, 198.51.100.7, 203.0.113.9'), 2)).toBe(
        'ip:198.51.100.7',
      );
    });
  });

  describe('when there is no X-Forwarded-For header', () => {
    it('keys on the socket address', () => {
      // A request that reaches the app without the header did not come
      // through the ingress (nginx sets it: proxy_add_x_forwarded_for),
      // so the peer address IS the client: local dev, an in-cluster
      // probe, a sidecar. Bucketing those per peer is correct, not a
      // fallback to the old shared-bucket behaviour.
      expect(throttlerTracker(req(undefined, '198.51.100.20'), 1)).toBe('ip:198.51.100.20');
    });

    it('keys on the socket address when the header is present but empty', () => {
      expect(
        throttlerTracker({ ip: '198.51.100.20', headers: { 'x-forwarded-for': '' } }, 1),
      ).toBe('ip:198.51.100.20');
    });

    it('falls back to a single shared bucket when nothing at all is knowable', () => {
      // A global guard must return something — unlike the anonymous
      // surface limiter it cannot skip the scope. Merging throttles
      // harder, never softer, so this errs in the safe direction.
      expect(throttlerTracker({ headers: {} }, 1)).toBe(UNIDENTIFIED_CLIENT_TRACKER);
      expect(throttlerTracker({}, 1)).toBe(UNIDENTIFIED_CLIENT_TRACKER);
    });

    it('reads the socket address when req.ip is absent', () => {
      expect(throttlerTracker({ headers: {}, socket: { remoteAddress: '198.51.100.30' } }, 1)).toBe(
        'ip:198.51.100.30',
      );
    });
  });

  describe('IPv6 normalisation', () => {
    it('collapses a /64 so one client cannot rotate through a subnet', () => {
      // Dropping normalizeIp would hand an IPv6 client 2^64 buckets.
      const first = throttlerTracker(req('2001:db8:1234:5678:1:2:3:4'), 1);
      const second = throttlerTracker(req('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd'), 1);

      expect(first).toBe(second);
      expect(first).toBe('ip:2001:db8:1234:5678::/64');
    });

    it('keeps a different /64 in a different bucket', () => {
      expect(throttlerTracker(req('2001:db8:1234:5678::1'), 1)).not.toBe(
        throttlerTracker(req('2001:db8:1234:9999::1'), 1),
      );
    });

    it('honours a narrower configured prefix', () => {
      expect(throttlerTracker(req('2001:db8:1234:5678::1'), 1, 32)).toBe('ip:2001:db8::/32');
    });

    it('keys an IPv4-mapped socket address as the IPv4 client, not a shared /64', () => {
      // A dual-stack listener reports direct IPv4 peers as ::ffff:a.b.c.d.
      // Collapsing that to a /64 would put every direct IPv4 client in
      // ::ffff:0:0/64 — one bucket again.
      expect(throttlerTracker(req(undefined, '::ffff:198.51.100.20'), 1)).toBe('ip:198.51.100.20');
      expect(throttlerTracker(req(undefined, '::ffff:198.51.100.21'), 1)).toBe('ip:198.51.100.21');
    });
  });

  describe('hop count from the environment', () => {
    const saved = process.env.TRUSTED_PROXY_HOPS;
    afterEach(() => {
      if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = saved;
    });

    it('defaults to one ingress when TRUSTED_PROXY_HOPS is unset', () => {
      delete process.env.TRUSTED_PROXY_HOPS;
      expect(throttlerTracker(req('forged, 203.0.113.77'))).toBe('ip:203.0.113.77');
    });

    it('reads the configured hop count without being passed one', () => {
      process.env.TRUSTED_PROXY_HOPS = '2';
      expect(throttlerTracker(req('forged, 198.51.100.7, 203.0.113.9'))).toBe('ip:198.51.100.7');
    });
  });
});
