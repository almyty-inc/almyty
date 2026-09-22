import { GatewayRateLimitService, burstPerMinute } from './gateway-rate-limit.service';

describe('GatewayRateLimitService', () => {
  // The counter is one atomic INCR+EXPIRE script, so the seam under
  // test is `eval`: [script, numKeys, key, ttlSeconds] -> count.
  let redis: { eval: jest.Mock };
  let service: GatewayRateLimitService;

  const gateway = (rateLimitConfig: any): any => ({ id: 'gw-1', rateLimitConfig });

  beforeEach(() => {
    redis = { eval: jest.fn() };
    service = new GatewayRateLimitService(redis as any);
  });

  it('passes when no config or disabled', async () => {
    expect(await service.check(gateway(null))).toEqual({ limited: false });
    expect(await service.check(gateway({ enabled: false, requestsPerMinute: 1 }))).toEqual({ limited: false });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('allows requests under the per-minute limit', async () => {
    redis.eval.mockResolvedValue(3);
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));
    expect(result.limited).toBe(false);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('limits requests over the per-minute limit with a Retry-After hint', async () => {
    redis.eval.mockResolvedValue(31);
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));
    expect(result.limited).toBe(true);
    expect(result.message).toContain('30 requests per minute');
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('names the bucket that tripped, so a 429 can say which limit', async () => {
    // The code distinguishes a surface ceiling from a visitor ceiling;
    // the bucket says which window and which number, so the record can
    // answer "which limit" without re-deriving the config by hand.
    redis.eval.mockResolvedValue(31);
    const surface = await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));
    expect(surface.code).toBe('SURFACE_RATE_LIMITED');
    expect(surface.bucket).toEqual({ window: 'minute', limit: 30, scope: 'surface' });

    redis.eval.mockResolvedValue(61);
    const visitor = await service.checkVisitor(
      gateway({ enabled: true, perVisitorPerHour: 60 }),
      { endUserId: 'visitor-1' },
    );
    expect(visitor.code).toBe('VISITOR_RATE_LIMITED');
    expect(visitor.bucket).toEqual({ window: 'hour', limit: 60, scope: 'user' });
  });

  it('counts and expires the window in one atomic call', async () => {
    // This was INCR followed by a separate EXPIRE issued only when the
    // count came back 1, so a process that died between the two round
    // trips left the key with no TTL and Redis kept it for good. One
    // script does both, and re-arms the TTL on a key found without one.
    redis.eval.mockResolvedValueOnce(1);
    await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, ttl] = redis.eval.mock.calls[0];
    expect(script).toMatch(/incr/);
    expect(script).toMatch(/expire/);
    expect(script).toMatch(/ttl/);
    expect(numKeys).toBe(1);
    expect(key).toContain('minute');
    expect(ttl).toBe('60');
  });

  it('never issues a bare EXPIRE, so no window can be left without a TTL', async () => {
    redis.eval.mockResolvedValue(1);
    await service.check(gateway({ enabled: true, requestsPerMinute: 30, requestsPerHour: 100 }));
    await service.checkVisitor(
      gateway({ enabled: true, perVisitorPerHour: 60 }),
      { endUserId: 'eu-1', clientHash: 'h' },
    );
    expect((redis as any).expire).toBeUndefined();
    expect((redis as any).incr).toBeUndefined();
  });

  it('checks hour and day windows too', async () => {
    redis.eval.mockResolvedValueOnce(5).mockResolvedValueOnce(101);
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 10, requestsPerHour: 100 }));
    expect(result.limited).toBe(true);
    expect(result.message).toContain('per hour');
  });

  it('fails open on Redis errors', async () => {
    redis.eval.mockRejectedValue(new Error('redis down'));
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 1 }));
    expect(result.limited).toBe(false);
  });

  describe('checkVisitor (per visitor / per address)', () => {
    const gw = (rateLimitConfig: any) => ({ id: 'gw-1', rateLimitConfig }) as any;

    it('does nothing when the surface has no per-visitor limits', async () => {
      await expect(service.checkVisitor(gw({ enabled: false }), { endUserId: 'eu-1', clientHash: 'h' })).resolves.toEqual({ limited: false });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('keys the counters on the visitor, not the surface', async () => {
      redis.eval.mockResolvedValue(1);
      await service.checkVisitor(gw({ enabled: false, perVisitorPerHour: 60 }), { endUserId: 'eu-1', clientHash: null });
      const keys = redis.eval.mock.calls.map((c) => c[2] as string);
      expect(keys.some((k) => k.startsWith('gw_rate:gw-1:user:eu-1:hour:'))).toBe(true);
      expect(keys.some((k) => k.startsWith('gw_rate:gw-1:user:eu-1:minute:'))).toBe(true);
    });

    it('limits one visitor without touching the others', async () => {
      // 61st message this hour for eu-1.
      redis.eval.mockResolvedValue(61);
      const out = await service.checkVisitor(gw({ enabled: false, perVisitorPerHour: 60 }), { endUserId: 'eu-1', clientHash: null });
      expect(out.limited).toBe(true);
      expect(out.code).toBe('VISITOR_RATE_LIMITED');
      expect(out.message).toMatch(/Too many messages from you \(60 per hour\)/);
      expect(out.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('applies a burst ceiling per minute so an hour cannot go in ten seconds', async () => {
      // hour bucket fine (1), minute bucket over burstPerMinute(60)=12.
      redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(13);
      const out = await service.checkVisitor(gw({ enabled: false, perVisitorPerHour: 60 }), { endUserId: 'eu-1', clientHash: null });
      expect(out.limited).toBe(true);
      expect(out.message).toMatch(/12 per minute/);
    });

    it('limits an address that has no visitor identity', async () => {
      redis.eval.mockResolvedValue(31);
      const out = await service.checkVisitor(gw({ enabled: false, perIpPerHour: 30 }), { endUserId: null, clientHash: 'abc' });
      expect(out.limited).toBe(true);
      expect(out.message).toMatch(/your network/);
    });

    it('fails open when Redis is down', async () => {
      redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.checkVisitor(gw({ enabled: false, perVisitorPerHour: 5 }), { endUserId: 'eu-1' })).resolves.toEqual({ limited: false });
    });
  });

  describe('burstPerMinute', () => {
    it('is a fifth of the hour, never below three', () => {
      expect(burstPerMinute(60)).toBe(12);
      expect(burstPerMinute(600)).toBe(120);
      expect(burstPerMinute(5)).toBe(3);
    });
  });
});
