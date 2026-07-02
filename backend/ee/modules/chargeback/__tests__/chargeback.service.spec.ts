import { ChargebackService } from '../chargeback.service';

/**
 * Unit tests for the EE chargeback service. SpendService is stubbed — we
 * assert that getReport composes the per-team, per-agent, timeseries and
 * forecast pieces and threads the window through unchanged.
 */
describe('ChargebackService', () => {
  const summary = {
    totalCents: 900,
    timeseries: [
      { periodStart: '2026-06-01T00:00:00.000Z', spentCents: 100, runCount: 1 },
      { periodStart: '2026-06-02T00:00:00.000Z', spentCents: 300, runCount: 2 },
    ],
    byAgent: [{ agentId: 'a1', spentCents: 900, runCount: 3 }],
  };
  const byTeam = [
    { teamId: 't1', spentCents: 600, runCount: 2 },
    { teamId: null, spentCents: 300, runCount: 1 },
  ];
  const forecast = {
    projectedCents: 500,
    perPeriodCents: 200,
    periodsAhead: 1,
    basis: 'linear' as const,
  };

  function makeSpend() {
    return {
      getSummary: jest.fn().mockResolvedValue(summary),
      byTeam: jest.fn().mockResolvedValue(byTeam),
      forecast: jest.fn().mockReturnValue(forecast),
    };
  }

  it('composes a full chargeback report', async () => {
    const spend = makeSpend();
    const svc = new ChargebackService(spend as any);
    const report = await svc.getReport('org-1', { period: 'month' });

    expect(report.totalCents).toBe(900);
    expect(report.byTeam).toEqual(byTeam);
    expect(report.byAgent).toEqual(summary.byAgent);
    expect(report.forecast).toEqual(forecast);
    expect(report.window.period).toBe('month');
    // forecast is computed over the returned timeseries.
    expect(spend.forecast).toHaveBeenCalledWith(summary.timeseries, 1);
  });

  it('passes the forecast horizon through', async () => {
    const spend = makeSpend();
    const svc = new ChargebackService(spend as any);
    await svc.getReport('org-1', { forecastPeriods: 3 });
    expect(spend.forecast).toHaveBeenCalledWith(summary.timeseries, 3);
  });

  it('defaults an unknown period to month', async () => {
    const spend = makeSpend();
    const svc = new ChargebackService(spend as any);
    const report = await svc.getReport('org-1', { period: 'week' as any });
    expect(report.window.period).toBe('month');
  });
});
