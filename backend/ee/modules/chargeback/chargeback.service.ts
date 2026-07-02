import { Injectable } from '@nestjs/common';

import {
  SpendService,
  SpendByAgent,
  SpendByTeam,
  SpendBucket,
  SpendForecast,
} from '../../../src/modules/budgets/spend.service';
import { startOfPeriod } from '../../../src/modules/budgets/spend-period.util';

export interface ChargebackReport {
  window: { period: 'day' | 'month'; from: string; to: string | null };
  totalCents: number;
  byTeam: SpendByTeam[];
  byAgent: SpendByAgent[];
  timeseries: SpendBucket[];
  forecast: SpendForecast;
}

export interface ChargebackOptions {
  period?: 'day' | 'month';
  granularity?: 'day' | 'week' | 'month';
  /** How many buckets ahead to project. */
  forecastPeriods?: number;
  to?: Date;
}

/**
 * EE (chargeback): cost attribution + showback + forecasting layered on the
 * P2 spend aggregation. It reuses `SpendService` for the underlying SQL —
 * no new spend pipeline — and adds per-team attribution + a linear spend
 * forecast on top of the existing per-agent + timeseries breakdown.
 */
@Injectable()
export class ChargebackService {
  constructor(private readonly spend: SpendService) {}

  async getReport(
    organizationId: string,
    opts: ChargebackOptions = {},
  ): Promise<ChargebackReport> {
    const period = opts.period === 'day' ? 'day' : 'month';
    const from = startOfPeriod(period, new Date());
    const granularity = opts.granularity ?? 'day';
    const forecastPeriods = opts.forecastPeriods ?? 1;

    const [summary, byTeam] = await Promise.all([
      this.spend.getSummary(organizationId, { from, to: opts.to, granularity }),
      this.spend.byTeam(organizationId, from, opts.to),
    ]);

    const forecast = this.spend.forecast(summary.timeseries, forecastPeriods);

    return {
      window: { period, from: from.toISOString(), to: opts.to ? opts.to.toISOString() : null },
      totalCents: summary.totalCents,
      byTeam,
      byAgent: summary.byAgent,
      timeseries: summary.timeseries,
      forecast,
    };
  }
}
