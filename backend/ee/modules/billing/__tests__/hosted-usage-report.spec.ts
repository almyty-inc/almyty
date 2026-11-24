import { HostedUsageReportService, billableDelta } from '../hosted-usage-report.service';
import { STRIPE_HOSTED_METERS_ENV, hostedMeterPrices, hostedMeters, hostedUsageReporting, meterIdentifier } from '../hosted-metering.config';

/**
 * The hourly runner-usage-report (design: "Recording to Stripe"): one row
 * and at most one Stripe meter event per (organization, class, hour),
 * identified `<org>:<class>:<hour>`, carrying only the minutes beyond the
 * plan's allowance, and idempotent under retry.
 */
const ORG = '11111111-1111-1111-1111-111111111111';
const HOUR = new Date('2026-11-10T09:00:00.000Z');
const METERS = JSON.stringify({ small: { eventName: 'hosted_minutes_small', price: 'price_small_minute' } });

describe('hosted metering configuration', () => {
  it('reads one meter per class and the prices to add to a subscription', () => {
    const env = { [STRIPE_HOSTED_METERS_ENV]: JSON.stringify({ small: { eventName: 'm_small', price: 'p_small' }, large: { eventName: 'm_large' }, bad: {} }) };
    expect(hostedMeters(env)).toEqual({ small: { eventName: 'm_small', price: 'p_small' }, large: { eventName: 'm_large', price: null } });
    expect(hostedMeterPrices(env)).toEqual(['p_small']);
    expect(hostedMeters({ [STRIPE_HOSTED_METERS_ENV]: 'nope' })).toEqual({});
  });

  it('runs hourly by default and can be turned off', () => {
    expect(hostedUsageReporting({})).toEqual({ cron: '5 * * * *', lookbackHours: 48 });
    expect(hostedUsageReporting({ HOSTED_USAGE_REPORTING: '{"cron":"off","lookbackHours":6}' })).toEqual({ cron: null, lookbackHours: 6 });
  });

  it('identifies an event by organization, class and hour', () => {
    expect(meterIdentifier(ORG, 'small', HOUR)).toBe(`${ORG}:small:2026-11-10T09:00:00.000Z`);
  });
});

describe('billableDelta', () => {
  it('bills nothing inside the allowance, whole minutes beyond it, and never drifts', () => {
    expect(billableDelta(0, 60, 2400)).toBe(0);
    expect(billableDelta(2380, 60, 2400)).toBe(40);
    expect(billableDelta(2500, 60, 2400)).toBe(60);
    // Fractions carry over: 30.5 + 30.5 beyond the allowance is 61 minutes, not 60.
    expect(billableDelta(2400, 30.5, 2400) + billableDelta(2430.5, 30.5, 2400)).toBe(61);
  });
});

describe('HostedUsageReportService', () => {
  let rows: any[];
  let stripe: { createMeterEvent: jest.Mock };
  let capacity: any;
  let monthBefore: number;
  let hourMinutes: number;

  const reports: any = {
    findOne: jest.fn(async ({ where }: any) =>
      rows.find((r) => r.organizationId === where.organizationId && r.resourceClass === where.resourceClass && +r.hourStart === +where.hourStart) ?? null,
    ),
    insert: jest.fn(async (row: any) => {
      if (rows.some((r) => r.meterIdentifier === row.meterIdentifier)) throw Object.assign(new Error('duplicate'), { code: '23505' });
      rows.push({ id: `r${rows.length + 1}`, ...row });
    }),
    update: jest.fn(async ({ id }: any, patch: any) => Object.assign(rows.find((r) => r.id === id), patch)),
  };
  const orgs: any = { findOne: jest.fn(async () => ({ id: ORG, billingInfo: { stripeCustomerId: 'cus_1' } })) };
  const dataSource: any = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (sql.trim().startsWith('UPDATE')) return [];
      const [from, to] = params;
      // The month-to-date question ends where the hour starts.
      const minutes = +to === +HOUR ? monthBefore : +from === +HOUR ? hourMinutes : 0;
      return minutes ? [{ organizationId: ORG, resourceClass: 'small', seconds: String(minutes * 60) }] : [];
    }),
  };

  const service = () => new HostedUsageReportService(reports, orgs, dataSource, stripe as any, capacity);

  beforeEach(() => {
    process.env[STRIPE_HOSTED_METERS_ENV] = METERS;
    rows = [];
    stripe = { createMeterEvent: jest.fn(async () => ({})) };
    capacity = { capacityFor: jest.fn(async () => ({ billed: true, includedMinutes: { small: 2400 } })) };
    monthBefore = 2380;
    hourMinutes = 60;
  });
  afterAll(() => delete process.env[STRIPE_HOSTED_METERS_ENV]);

  it('sends one meter event for an hour with the minutes beyond the allowance', async () => {
    const result = await service().reportHour(HOUR);
    expect(result).toEqual({ rows: 1, sent: 1, failed: 0 });
    expect(stripe.createMeterEvent).toHaveBeenCalledTimes(1);
    expect(stripe.createMeterEvent).toHaveBeenCalledWith({
      event_name: 'hosted_minutes_small',
      identifier: meterIdentifier(ORG, 'small', HOUR),
      payload: { stripe_customer_id: 'cus_1', value: '40' },
      timestamp: Math.floor(HOUR.getTime() / 1000) + 3599,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ minutes: 60, billableMinutes: 40, destination: 'stripe' });
    expect(rows[0].reportedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a second run of the same hour sends nothing more', async () => {
    await service().reportHour(HOUR);
    await service().reportHour(HOUR);
    expect(stripe.createMeterEvent).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('retries a failed send under the same identifier, and takes Stripe saying it has it as sent', async () => {
    stripe.createMeterEvent.mockRejectedValueOnce(new Error('connection reset'));
    expect(await service().reportHour(HOUR)).toEqual({ rows: 1, sent: 0, failed: 1 });
    expect(rows[0].reportedAt).toBeNull();
    expect(rows[0].lastError).toBe('connection reset');

    // Stripe's own wording (test mode, 2026-11-24).
    stripe.createMeterEvent.mockRejectedValueOnce(Object.assign(new Error('An event already exists with identifier x.'), { type: 'StripeInvalidRequestError' }));
    expect(await service().reportHour(HOUR)).toEqual({ rows: 1, sent: 1, failed: 0 });
    const ids = stripe.createMeterEvent.mock.calls.map((c) => c[0].identifier);
    expect(new Set(ids).size).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].reportedAt).toBeInstanceOf(Date);
  });

  it('records minutes inside the allowance without sending anything', async () => {
    monthBefore = 0;
    await service().reportHour(HOUR);
    expect(stripe.createMeterEvent).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ minutes: 60, billableMinutes: 0, destination: 'recorded' });
    expect(rows[0].reportedAt).toBeInstanceOf(Date);
  });

  it('records an Enterprise contract (not billed) and never sends it to Stripe', async () => {
    capacity.capacityFor.mockResolvedValue({ billed: false, includedMinutes: null });
    monthBefore = 1e6;
    await service().reportHour(HOUR);
    expect(stripe.createMeterEvent).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ billableMinutes: 0, destination: 'recorded' });
  });

  it('records, and does not send, minutes of a class with no meter configured', async () => {
    process.env[STRIPE_HOSTED_METERS_ENV] = JSON.stringify({});
    await service().reportHour(HOUR);
    expect(stripe.createMeterEvent).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ billableMinutes: 40, destination: 'recorded' });
  });

  it('works through every finished hour in the lookback window', async () => {
    process.env.HOSTED_USAGE_REPORTING = '{"lookbackHours":3}';
    const s = service();
    const spy = jest.spyOn(s, 'reportHour').mockResolvedValue({ rows: 0, sent: 0, failed: 0 });
    await s.run(new Date('2026-11-10T12:20:00.000Z'));
    expect(spy.mock.calls.map((c) => (c[0] as Date).toISOString())).toEqual([
      '2026-11-10T09:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-11-10T11:00:00.000Z',
    ]);
    delete process.env.HOSTED_USAGE_REPORTING;
  });
});
