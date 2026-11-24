/**
 * How hosted runner minutes reach Stripe. Configuration only: no
 * allowance lives here (the allowance is plan capacity, hosted-capacity.ts)
 * and the price that is charged is the Stripe price itself.
 *
 * STRIPE_HOSTED_METERS, JSON keyed by resource class:
 *
 *   {"small": {"eventName": "hosted_runner_minutes_small", "price": "price_...", "usdPerMinute": 0.001},
 *    "large": {"eventName": "hosted_runner_minutes_large", "price": "price_...", "usdPerMinute": 0.004}}
 *
 * `eventName` is the Stripe Billing Meter's event name (one meter per
 * class, summing `value`); `price` is a metered price on that meter, per
 * minute. Checkout adds each price to a Pro or Business subscription, and
 * the webhook adds any the subscription lacks. A class with no entry is
 * recorded and never sent. `usdPerMinute` repeats that price's amount so
 * the monthly dollar ceiling (`monthlyCeilingUsd`) can be counted without
 * asking Stripe; a class without it adds nothing toward that ceiling.
 *
 * HOSTED_USAGE_REPORTING, JSON, tunes the hourly job:
 *   cron          when it runs (default "5 * * * *"; "off" turns it off)
 *   lookbackHours how many finished hours each run looks at, so a missed
 *                 run or a Stripe outage is caught up (default 48)
 */
export const STRIPE_HOSTED_METERS_ENV = 'STRIPE_HOSTED_METERS';
export const HOSTED_USAGE_REPORTING_ENV = 'HOSTED_USAGE_REPORTING';

export interface HostedMeter {
  eventName: string;
  price: string | null;
  /** The price per minute in US dollars, as set on the Stripe price; null: not given. */
  usdPerMinute: number | null;
}

/** The per-minute price of each configured size, where one is given. */
export function hostedMinutePrices(env: Env = process.env): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [cls, meter] of Object.entries(hostedMeters(env))) if (meter.usdPerMinute !== null) out[cls] = meter.usdPerMinute;
  return out;
}

export interface HostedUsageReporting {
  cron: string | null;
  lookbackHours: number;
}

export const DEFAULT_HOSTED_USAGE_REPORTING: HostedUsageReporting = { cron: '5 * * * *', lookbackHours: 48 };

type Env = Record<string, string | undefined>;

function parse(raw: string | undefined): any {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The configured meter per resource class; classes without a valid entry are left out. */
export function hostedMeters(env: Env = process.env): Record<string, HostedMeter> {
  const parsed = parse(env[STRIPE_HOSTED_METERS_ENV]);
  const out: Record<string, HostedMeter> = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [cls, row] of Object.entries(parsed as Record<string, any>)) {
    if (!row || typeof row !== 'object' || typeof row.eventName !== 'string' || !row.eventName.trim()) continue;
    const usd = Number(row.usdPerMinute);
    out[cls] = {
      eventName: row.eventName.trim(),
      price: typeof row.price === 'string' && row.price.trim() ? row.price.trim() : null,
      usdPerMinute: row.usdPerMinute !== null && row.usdPerMinute !== undefined && row.usdPerMinute !== '' && Number.isFinite(usd) && usd >= 0 ? usd : null,
    };
  }
  return out;
}

/** The metered prices checkout and the webhook add to a subscription. */
export function hostedMeterPrices(env: Env = process.env): string[] {
  return Array.from(new Set(Object.values(hostedMeters(env)).map((m) => m.price).filter((p): p is string => !!p)));
}

export function hostedUsageReporting(env: Env = process.env): HostedUsageReporting {
  const parsed = parse(env[HOSTED_USAGE_REPORTING_ENV]) ?? {};
  const out: HostedUsageReporting = { ...DEFAULT_HOSTED_USAGE_REPORTING };
  if (typeof parsed.cron === 'string' && parsed.cron.trim()) out.cron = parsed.cron.trim().toLowerCase() === 'off' ? null : parsed.cron.trim();
  const hours = Number(parsed.lookbackHours);
  if (Number.isInteger(hours) && hours > 0) out.lookbackHours = hours;
  return out;
}

/** The identifier Stripe deduplicates a meter event on: one per (organization, class, hour). */
export function meterIdentifier(organizationId: string, resourceClass: string, hourStart: Date): string {
  return `${organizationId}:${resourceClass}:${hourStart.toISOString()}`;
}
