import {
  clampTimeframe,
  clampGranularity,
  timeframeHours,
  MAX_ANALYTICS_WINDOW_DAYS,
  MAX_TIMELINE_BUCKETS,
  DEFAULT_ANALYTICS_TIMEFRAME,
} from '../analytics-timeframe';
import { AnalyticsController } from '../analytics.controller';

/**
 * `timeframe` used to travel from the query string into a regex-parsed
 * window with no upper bound. `?timeframe=9999m` is ~833 years and turns
 * every aggregate into a full-table scan; `?timeframe=999d&granularity=minute`
 * asks for up to 1.44M buckets as one JSON array.
 */
describe('analytics timeframe clamping', () => {
  it('parses the units the analytics window understands', () => {
    expect(timeframeHours('24h')).toBe(24);
    expect(timeframeHours('7d')).toBe(168);
    expect(timeframeHours('2w')).toBe(336);
    expect(timeframeHours('1m')).toBe(720);
    expect(timeframeHours('nonsense')).toBeNull();
    expect(timeframeHours('0d')).toBeNull();
    expect(timeframeHours(undefined)).toBeNull();
  });

  it('caps a window the caller asks for at MAX_ANALYTICS_WINDOW_DAYS', () => {
    expect(clampTimeframe('9999m')).toBe(`${MAX_ANALYTICS_WINDOW_DAYS}d`);
    expect(clampTimeframe('999d')).toBe(`${MAX_ANALYTICS_WINDOW_DAYS}d`);
    expect(clampTimeframe('100000h')).toBe(`${MAX_ANALYTICS_WINDOW_DAYS}d`);
    // The clamped value must itself be inside the bound.
    expect(timeframeHours(clampTimeframe('9999m'))).toBeLessThanOrEqual(
      MAX_ANALYTICS_WINDOW_DAYS * 24,
    );
  });

  it('leaves a reasonable window alone and defaults an unparseable one', () => {
    expect(clampTimeframe('24h')).toBe('24h');
    expect(clampTimeframe('30d')).toBe('30d');
    expect(clampTimeframe('12w')).toBe('12w');
    expect(clampTimeframe('drop table')).toBe(DEFAULT_ANALYTICS_TIMEFRAME);
    expect(clampTimeframe(undefined)).toBe(DEFAULT_ANALYTICS_TIMEFRAME);
  });

  it('coarsens granularity so one timeline never exceeds MAX_TIMELINE_BUCKETS', () => {
    // 90 days at minute granularity would be 129,600 buckets.
    expect(clampGranularity('90d', 'minute')).toBe('day');
    // 24h at minute granularity is 1,440 — under the cap, so it stands.
    expect(clampGranularity('24h', 'minute')).toBe('minute');
    // 90 days by hour is 2,160 — just over, so it coarsens to day.
    expect(clampGranularity('90d', 'hour')).toBe('day');
    expect(clampGranularity('7d', 'hour')).toBe('hour');
    expect(clampGranularity('90d', 'day')).toBe('day');
  });

  it('never coarsens below what the cap requires', () => {
    for (const timeframe of ['1h', '24h', '7d', '30d', '90d']) {
      for (const granularity of ['minute', 'hour', 'day']) {
        const chosen = clampGranularity(timeframe, granularity);
        const hours = timeframeHours(timeframe)!;
        const buckets = chosen === 'minute' ? hours * 60 : chosen === 'hour' ? hours : hours / 24;
        expect(buckets).toBeLessThanOrEqual(MAX_TIMELINE_BUCKETS);
      }
    }
  });
});

describe('AnalyticsController passes only clamped windows to the service', () => {
  const req = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };

  const makeController = () => {
    const analyticsService: any = {
      getToolUsage: jest.fn().mockResolvedValue([]),
      getGatewayUsage: jest.fn().mockResolvedValue([]),
      getLlmUsage: jest.fn().mockResolvedValue([]),
      getTimeline: jest.fn().mockResolvedValue([]),
    };
    const controller = new AnalyticsController(analyticsService);
    return { controller, analyticsService };
  };

  it('clamps the usage endpoints', async () => {
    const { controller, analyticsService } = makeController();

    await controller.getToolUsage(req, '9999m');
    await controller.getGatewayUsage(req, '9999m');
    await controller.getLlmUsage(req, '9999m');

    const ceiling = `${MAX_ANALYTICS_WINDOW_DAYS}d`;
    // The third argument is the caller, used to leave other members'
    // private tools, gateways and providers out.
    expect(analyticsService.getToolUsage).toHaveBeenCalledWith('org-1', ceiling, 'user-1');
    expect(analyticsService.getGatewayUsage).toHaveBeenCalledWith('org-1', ceiling, 'user-1');
    expect(analyticsService.getLlmUsage).toHaveBeenCalledWith('org-1', ceiling, 'user-1');
  });

  it('clamps both the window and the bucket size on the timeline', async () => {
    const { controller, analyticsService } = makeController();

    await controller.getTimeline(req, '999d', 'minute');

    expect(analyticsService.getTimeline).toHaveBeenCalledWith(
      'org-1',
      `${MAX_ANALYTICS_WINDOW_DAYS}d`,
      'day',
    );
  });

  it('leaves a sane timeline request untouched', async () => {
    const { controller, analyticsService } = makeController();

    await controller.getTimeline(req, '24h', 'hour');

    expect(analyticsService.getTimeline).toHaveBeenCalledWith('org-1', '24h', 'hour');
  });
});
