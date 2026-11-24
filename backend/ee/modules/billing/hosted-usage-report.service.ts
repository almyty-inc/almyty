import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Organization } from '../../../src/entities/organization.entity';
import { RunnerUsageReport } from '../../../src/entities/runner-usage-report.entity';
import { isUniqueViolation } from '../../../src/common/utils/unique-violation';
import { HOSTED_CAPACITY_PROVIDER, HostedCapacityProvider } from '../../../src/modules/hosted-runners/hosted-capacity.provider';
import { StripeService } from './stripe.service';
import { hostedMeters, hostedUsageReporting, meterIdentifier } from './hosted-metering.config';

const HOUR_MS = 60 * 60 * 1000;

export interface UsageReportRun {
  hours: number;
  rows: number;
  sent: number;
  failed: number;
}

function hourFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Whole minutes beyond the allowance, counted from the start of the month so rounding never drifts. */
export function billableDelta(minutesBefore: number, minutesInHour: number, includedMinutes: number): number {
  const over = (m: number) => Math.floor(Math.max(0, m - includedMinutes));
  return Math.max(0, over(minutesBefore + minutesInHour) - over(minutesBefore));
}

/**
 * The hourly `runner-usage-report` (design: "Recording to Stripe"). For
 * each finished hour in the lookback window it sums every organization's
 * runner minutes per resource class (closed and still-open intervals, up
 * to the hour's end), writes one `runner_usage_reports` row per
 * (organization, class, hour), and sends one Stripe meter event for the
 * minutes beyond the plan's allowance, identified `<org>:<class>:<hour>`.
 *
 * Idempotent on retry twice over: the unique row means an hour is worked
 * out once, and Stripe deduplicates on the identifier, so an event whose
 * acknowledgement was lost is sent again harmlessly. The allowance is
 * counted here rather than as a free Stripe tier because it grows with
 * seats. An Enterprise contract, a plan with no subscription, and a class
 * with no meter are recorded and never sent.
 */
@Injectable()
export class HostedUsageReportService {
  private readonly logger = new Logger(HostedUsageReportService.name);

  constructor(
    @InjectRepository(RunnerUsageReport) private readonly reports: Repository<RunnerUsageReport>,
    @InjectRepository(Organization) private readonly orgs: Repository<Organization>,
    private readonly dataSource: DataSource,
    private readonly stripe: StripeService,
    @Optional() @Inject(HOSTED_CAPACITY_PROVIDER) private readonly capacity?: HostedCapacityProvider,
  ) {}

  /** Every finished hour in the lookback window, oldest first. */
  async run(now = new Date()): Promise<UsageReportRun> {
    const { lookbackHours } = hostedUsageReporting();
    const last = hourFloor(now).getTime() - HOUR_MS;
    const out: UsageReportRun = { hours: 0, rows: 0, sent: 0, failed: 0 };
    for (let i = lookbackHours - 1; i >= 0; i--) {
      const r = await this.reportHour(new Date(last - i * HOUR_MS), now);
      out.hours++;
      out.rows += r.rows;
      out.sent += r.sent;
      out.failed += r.failed;
    }
    return out;
  }

  async reportHour(hourStart: Date, now = new Date()): Promise<{ rows: number; sent: number; failed: number }> {
    const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
    const rows = await this.minutes(null, null, hourStart, hourEnd);
    const out = { rows: 0, sent: 0, failed: 0 };
    for (const row of rows) {
      if (!(row.minutes > 0)) continue;
      out.rows++;
      const result = await this.reportOne(row.organizationId, row.resourceClass, hourStart, row.minutes, now);
      if (result === 'sent') out.sent++;
      if (result === 'failed') out.failed++;
    }
    return out;
  }

  /** One (organization, class, hour): work it out once, then send it until Stripe has it. */
  async reportOne(organizationId: string, resourceClass: string, hourStart: Date, minutes: number, now = new Date()): Promise<'done' | 'recorded' | 'sent' | 'failed'> {
    let row = await this.reports.findOne({ where: { organizationId, resourceClass, hourStart } });
    if (row?.reportedAt) return 'done';
    if (!row) {
      row = await this.workOut(organizationId, resourceClass, hourStart, minutes, now);
      if (row.reportedAt) {
        await this.stampIntervals(row);
        return 'recorded';
      }
    }
    return this.send(row, now);
  }

  private async workOut(organizationId: string, resourceClass: string, hourStart: Date, minutes: number, now: Date): Promise<RunnerUsageReport> {
    const capacity = this.capacity ? await this.capacity.capacityFor(organizationId) : null;
    const included = capacity?.includedMinutes ? (capacity.includedMinutes[resourceClass] ?? 0) : null;
    let billable = 0;
    if (capacity?.billed === true && included !== null) {
      const before = (await this.minutes(organizationId, resourceClass, monthStart(hourStart), hourStart))[0]?.minutes ?? 0;
      billable = billableDelta(before, minutes, included);
    }
    const meter = hostedMeters()[resourceClass];
    const destination: RunnerUsageReport['destination'] = billable > 0 && meter ? 'stripe' : 'recorded';
    if (billable > 0 && !meter) this.logger.warn(`No Stripe meter configured for hosted class "${resourceClass}"; ${billable} billable minutes of ${organizationId} recorded only`);
    const fields: Partial<RunnerUsageReport> = {
      organizationId,
      resourceClass,
      hourStart,
      minutes,
      billableMinutes: billable,
      destination,
      meterIdentifier: meterIdentifier(organizationId, resourceClass, hourStart),
      reportedAt: destination === 'recorded' ? now : null,
      lastError: null,
    };
    try {
      await this.reports.insert(fields);
    } catch (err) {
      // Another pod worked the same hour out first: use its row.
      if (!isUniqueViolation(err)) throw err;
    }
    const saved = await this.reports.findOne({ where: { organizationId, resourceClass, hourStart } });
    return saved ?? (fields as RunnerUsageReport);
  }

  private async send(row: RunnerUsageReport, now: Date): Promise<'sent' | 'failed' | 'done'> {
    if (row.destination !== 'stripe') return 'done';
    const meter = hostedMeters()[row.resourceClass];
    const org = await this.orgs.findOne({ where: { id: row.organizationId } });
    const customer = org?.billingInfo?.stripeCustomerId;
    if (!meter || !customer) {
      await this.reports.update({ id: row.id }, { lastError: !meter ? 'no meter configured for this class' : 'the organization has no Stripe customer' });
      return 'failed';
    }
    try {
      await this.stripe.createMeterEvent({
        event_name: meter.eventName,
        identifier: row.meterIdentifier,
        payload: { stripe_customer_id: customer, value: String(row.billableMinutes) },
        // The last second of the hour it counts.
        timestamp: Math.floor((new Date(row.hourStart).getTime() + HOUR_MS) / 1000) - 1,
      });
    } catch (err: any) {
      if (!isDuplicateEvent(err)) {
        const message = String(err?.message ?? err).slice(0, 500);
        await this.reports.update({ id: row.id }, { lastError: message });
        this.logger.warn(`Stripe meter event ${row.meterIdentifier} not sent: ${message}`);
        return 'failed';
      }
      // Stripe has it already: an earlier send whose answer we lost.
    }
    await this.reports.update({ id: row.id }, { reportedAt: now, lastError: null });
    await this.stampIntervals({ ...row, reportedAt: now });
    return 'sent';
  }

  /** Mark the intervals that ended by the hour's end as reported under it. */
  private async stampIntervals(row: Pick<RunnerUsageReport, 'organizationId' | 'resourceClass' | 'hourStart' | 'meterIdentifier' | 'reportedAt'>): Promise<void> {
    const hourEnd = new Date(new Date(row.hourStart).getTime() + HOUR_MS);
    await this.dataSource.query(
      `UPDATE runner_usage_intervals SET "reportedAt" = $1, "meterIdentifier" = $2
        WHERE "organizationId" = $3 AND "resourceClass" = $4 AND "endedAt" IS NOT NULL AND "endedAt" <= $5 AND "reportedAt" IS NULL`,
      [row.reportedAt, row.meterIdentifier, row.organizationId, row.resourceClass, hourEnd],
    );
  }

  /** Minutes per (organization, class) in [from, to), open intervals counted up to `to`; optionally one of each. */
  private async minutes(organizationId: string | null, resourceClass: string | null, from: Date, to: Date) {
    const rows: Array<{ organizationId: string; resourceClass: string; seconds: string }> = await this.dataSource.query(
      `SELECT "organizationId", "resourceClass",
              SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE("endedAt", $2), $2) - GREATEST("startedAt", $1)))) AS seconds
         FROM runner_usage_intervals
        WHERE "startedAt" < $2 AND ("endedAt" IS NULL OR "endedAt" > $1)
          AND ($3::uuid IS NULL OR "organizationId" = $3) AND ($4::varchar IS NULL OR "resourceClass" = $4)
        GROUP BY "organizationId", "resourceClass"
        ORDER BY "organizationId", "resourceClass"`,
      [from, to, organizationId, resourceClass],
    );
    return rows.map((r) => ({ organizationId: r.organizationId, resourceClass: r.resourceClass, minutes: Math.max(0, Number(r.seconds)) / 60 }));
  }
}

/** Stripe refusing an event because one with this identifier exists. */
function isDuplicateEvent(err: any): boolean {
  const text = `${err?.code ?? ''} ${err?.raw?.code ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return text.includes('duplicate') || (text.includes('identifier') && text.includes('already'));
}
