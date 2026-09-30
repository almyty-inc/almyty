import { VisitorAuthMode as AppAuthMode } from '../../../entities/agent-channel.entity';
import {
  DEFAULT_PUBLIC_DAILY_SPEND_CAP_CENTS,
  DEFAULT_PUBLIC_MONTHLY_SPEND_CAP_CENTS,
  normalizeLimits,
  spendCapsFrom as appSpendCapsFrom,
} from '../channel-rules';
import { spendPeriods } from '../../gateways/channel-policy.service';

describe('spendCapsFrom', () => {
  it('caps an agent open to anyone at five dollars a day and fifty a month by default', () => {
    expect(DEFAULT_PUBLIC_DAILY_SPEND_CAP_CENTS).toBe(500);
    expect(DEFAULT_PUBLIC_MONTHLY_SPEND_CAP_CENTS).toBe(5000);
    for (const authMode of [AppAuthMode.PUBLIC_LINK, AppAuthMode.EMAIL_OTP, AppAuthMode.OAUTH]) {
      expect(appSpendCapsFrom({ authMode, limits: { costCapCents: 50 } })).toEqual({ dailyCents: 500, monthlyCents: 5000 });
      expect(appSpendCapsFrom({ authMode, limits: null })).toEqual({ dailyCents: 500, monthlyCents: 5000 });
    }
  });

  it('starts a gated agent with no spend cap', () => {
    expect(appSpendCapsFrom({ authMode: AppAuthMode.SSO, limits: {} })).toEqual({ dailyCents: null, monthlyCents: null });
  });

  it('takes the owner values, and null or zero as no cap', () => {
    expect(appSpendCapsFrom({ authMode: AppAuthMode.PUBLIC_LINK, limits: { dailySpendCapCents: 200, monthlySpendCapCents: 1000.7 } }))
      .toEqual({ dailyCents: 200, monthlyCents: 1000 });
    expect(appSpendCapsFrom({ authMode: AppAuthMode.PUBLIC_LINK, limits: { dailySpendCapCents: null, monthlySpendCapCents: 0 } }))
      .toEqual({ dailyCents: null, monthlyCents: null });
    expect(appSpendCapsFrom({ authMode: AppAuthMode.SSO, limits: { dailySpendCapCents: 300 } }))
      .toEqual({ dailyCents: 300, monthlyCents: null });
  });
});

describe('normalizeLimits', () => {
  it('keeps the known fields as whole numbers and drops the rest', () => {
    expect(
      normalizeLimits({ costCapCents: 50.9, perUserRateLimit: 60, dailySpendCapCents: 500, monthlySpendCapCents: null, bogus: 1 }),
    ).toEqual({ costCapCents: 50, perUserRateLimit: 60, dailySpendCapCents: 500, monthlySpendCapCents: null });
  });

  it('leaves a field that was not sent out, so it keeps meaning "the default"', () => {
    expect(normalizeLimits({ costCapCents: 50 })).toEqual({ costCapCents: 50 });
    expect(normalizeLimits(null)).toBeNull();
  });

  it('refuses a negative or non-numeric limit', () => {
    expect(() => normalizeLimits({ dailySpendCapCents: -1 })).toThrow(/whole numbers/);
    expect(() => normalizeLimits({ dailySpendCapCents: '5' })).toThrow(/whole numbers/);
  });
});

describe('spendPeriods', () => {
  it('counts a UTC day and a UTC calendar month', () => {
    const p = spendPeriods(new Date('2026-12-31T23:30:00Z'));
    expect(p.dayStart.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(p.nextDay.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(p.monthStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(p.nextMonth.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
