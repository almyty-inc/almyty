import { GatewayRateLimitService } from './gateway-rate-limit.service';

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
});
