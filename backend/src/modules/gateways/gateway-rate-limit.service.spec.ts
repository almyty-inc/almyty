import { GatewayRateLimitService, burstPerMinute } from './gateway-rate-limit.service';

describe('GatewayRateLimitService', () => {
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let service: GatewayRateLimitService;

  const gateway = (rateLimitConfig: any): any => ({ id: 'gw-1', rateLimitConfig });

  beforeEach(() => {
    redis = { incr: jest.fn(), expire: jest.fn().mockResolvedValue(1) };
    service = new GatewayRateLimitService(redis as any);
  });

  it('passes when no config or disabled', async () => {
    expect(await service.check(gateway(null))).toEqual({ limited: false });
    expect(await service.check(gateway({ enabled: false, requestsPerMinute: 1 }))).toEqual({ limited: false });
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('allows requests under the per-minute limit', async () => {
    redis.incr.mockResolvedValue(3);
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));
    expect(result.limited).toBe(false);
    expect(redis.incr).toHaveBeenCalledTimes(1);
  });

  it('limits requests over the per-minute limit with a Retry-After hint', async () => {
    redis.incr.mockResolvedValue(31);
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));
    expect(result.limited).toBe(true);
    expect(result.message).toContain('30 requests per minute');
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('sets the window TTL only on the first hit', async () => {
    redis.incr.mockResolvedValueOnce(1);
    await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('minute'), 60);

    redis.expire.mockClear();
    redis.incr.mockResolvedValueOnce(2);
    await service.check(gateway({ enabled: true, requestsPerMinute: 30 }));
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('checks hour and day windows too', async () => {
    redis.incr.mockResolvedValueOnce(5).mockResolvedValueOnce(101);
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 10, requestsPerHour: 100 }));
    expect(result.limited).toBe(true);
    expect(result.message).toContain('per hour');
  });

  it('fails open on Redis errors', async () => {
    redis.incr.mockRejectedValue(new Error('redis down'));
    const result = await service.check(gateway({ enabled: true, requestsPerMinute: 1 }));
    expect(result.limited).toBe(false);
  });

  describe('checkVisitor (per visitor / per address)', () => {
    const gw = (rateLimitConfig: any) => ({ id: 'gw-1', rateLimitConfig }) as any;

    it('does nothing when the surface has no per-visitor limits', async () => {
      await expect(service.checkVisitor(gw({ enabled: false }), { endUserId: 'eu-1', clientHash: 'h' })).resolves.toEqual({ limited: false });
      expect(redis.incr).not.toHaveBeenCalled();
    });

    it('keys the counters on the visitor, not the surface', async () => {
      redis.incr.mockResolvedValue(1);
      await service.checkVisitor(gw({ enabled: false, perVisitorPerHour: 60 }), { endUserId: 'eu-1', clientHash: null });
      const keys = redis.incr.mock.calls.map((c) => c[0] as string);
      expect(keys.some((k) => k.startsWith('gw_rate:gw-1:user:eu-1:hour:'))).toBe(true);
      expect(keys.some((k) => k.startsWith('gw_rate:gw-1:user:eu-1:minute:'))).toBe(true);
    });

    it('limits one visitor without touching the others', async () => {
      // 61st message this hour for eu-1.
      redis.incr.mockResolvedValue(61);
      const out = await service.checkVisitor(gw({ enabled: false, perVisitorPerHour: 60 }), { endUserId: 'eu-1', clientHash: null });
      expect(out.limited).toBe(true);
      expect(out.code).toBe('VISITOR_RATE_LIMITED');
      expect(out.message).toMatch(/Too many messages from you \(60 per hour\)/);
      expect(out.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('applies a burst ceiling per minute so an hour cannot go in ten seconds', async () => {
      // hour bucket fine (1), minute bucket over burstPerMinute(60)=12.
      redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(13);
      const out = await service.checkVisitor(gw({ enabled: false, perVisitorPerHour: 60 }), { endUserId: 'eu-1', clientHash: null });
      expect(out.limited).toBe(true);
      expect(out.message).toMatch(/12 per minute/);
    });

    it('limits an address that has no visitor identity', async () => {
      redis.incr.mockResolvedValue(31);
      const out = await service.checkVisitor(gw({ enabled: false, perIpPerHour: 30 }), { endUserId: null, clientHash: 'abc' });
      expect(out.limited).toBe(true);
      expect(out.message).toMatch(/your network/);
    });

    it('fails open when Redis is down', async () => {
      redis.incr.mockRejectedValue(new Error('ECONNREFUSED'));
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
