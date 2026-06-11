import { MetricsRetentionService } from './metrics-retention.service';

describe('MetricsRetentionService', () => {
  const ORIG = { ...process.env };

  function build(env: Record<string, string | undefined> = {}) {
    process.env = { ...ORIG, ...env };
    const usageMetric: any = { query: jest.fn() };
    const requestLog: any = { query: jest.fn() };
    const redis: any = { set: jest.fn(), eval: jest.fn().mockResolvedValue(1) };
    const service = new MetricsRetentionService(usageMetric, requestLog, redis);
    return { service, usageMetric, requestLog, redis };
  }

  afterEach(() => {
    process.env = { ...ORIG };
    jest.clearAllMocks();
  });

  it('prunes both tables when it wins the lock, deleting rows past the window', async () => {
    const { service, usageMetric, requestLog, redis } = build({ METRICS_RETENTION_DAYS: '30' });
    redis.set.mockResolvedValue('OK');
    // One short batch each => single iteration, then stop.
    usageMetric.query.mockResolvedValue([{ '?column?': 1 }, { '?column?': 1 }]);
    requestLog.query.mockResolvedValue([{ '?column?': 1 }]);

    const result = await service.sweep();

    expect(result).toEqual({ usage_metrics: 2, request_logs: 1 });

    // Cutoff is ~30 days back and shared across both tables.
    const [, params] = usageMetric.query.mock.calls[0];
    const cutoff: Date = params[0];
    const ageDays = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);
    expect(usageMetric.query.mock.calls[0][0]).toMatch(/DELETE FROM usage_metrics/);
    expect(requestLog.query.mock.calls[0][0]).toMatch(/DELETE FROM request_logs/);

    // Lock taken with NX + expiry, and released afterwards.
    expect(redis.set).toHaveBeenCalledWith('metrics:retention:lock', expect.any(String), 'EX', 3600, 'NX');
    expect(redis.eval).toHaveBeenCalled();
  });

  it('keeps deleting in batches until a short batch signals the end', async () => {
    const { service, usageMetric, requestLog, redis } = build({
      METRICS_RETENTION_DAYS: '90',
      METRICS_RETENTION_BATCH: '2',
    });
    redis.set.mockResolvedValue('OK');
    // usage_metrics: full batch, full batch, then a short one.
    usageMetric.query
      .mockResolvedValueOnce([1, 1])
      .mockResolvedValueOnce([1, 1])
      .mockResolvedValueOnce([1]);
    requestLog.query.mockResolvedValue([]); // nothing to prune

    const result = await service.sweep();

    expect(usageMetric.query).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ usage_metrics: 5, request_logs: 0 });
  });

  it('does nothing when another replica holds the lock', async () => {
    const { service, usageMetric, requestLog, redis } = build({ METRICS_RETENTION_DAYS: '90' });
    redis.set.mockResolvedValue(null); // NX failed

    const result = await service.sweep();

    expect(result).toBeNull();
    expect(usageMetric.query).not.toHaveBeenCalled();
    expect(requestLog.query).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('is disabled when retention is non-positive', async () => {
    const { service, redis } = build({ METRICS_RETENTION_DAYS: '0' });
    await expect(service.sweep()).resolves.toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('releases the lock even if a delete throws', async () => {
    const { service, usageMetric, redis } = build({ METRICS_RETENTION_DAYS: '90' });
    redis.set.mockResolvedValue('OK');
    usageMetric.query.mockRejectedValue(new Error('db down'));

    await expect(service.sweep()).rejects.toThrow('db down');
    expect(redis.eval).toHaveBeenCalled(); // lock released in finally
  });
});
