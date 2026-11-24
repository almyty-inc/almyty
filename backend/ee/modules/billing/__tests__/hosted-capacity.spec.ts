import { readFileSync } from 'fs';
import { join } from 'path';

import {
  HOSTED_PLAN_CAPACITY_ENV,
  PLAN_HOSTED_CAPACITY,
  hostedPlanCapacity,
  includedMinutes,
  orgHostedCapacity,
} from '../hosted-capacity';
import { PlanHostedCapacityProvider } from '../plan-hosted-capacity.provider';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../../../../src/modules/hosted-runners/hosted-runner-settings';

/**
 * Hosted capacity per plan (design: "Capacity", Decision 5): the catalog
 * seeds a row, HOSTED_PLAN_CAPACITY overrides it, an organization may only
 * tighten it. Free has no hosted machines; numbers the owner has not set
 * fall back to the install's settings rather than to a number in code.
 */
describe('hosted plan capacity', () => {
  it('gives Free no hosted machines and Pro the seeded allowance', () => {
    expect(hostedPlanCapacity('free', {})).toMatchObject({ hostedEnvironments: false, maxConcurrentRunners: 0, billed: false });
    expect(hostedPlanCapacity('pro', {})).toMatchObject({ hostedEnvironments: true, billed: true, includedHoursPerSeat: { small: 40 } });
    expect(hostedPlanCapacity('enterprise', {})).toMatchObject({ hostedEnvironments: true, billed: false, includedHoursPerSeat: null });
    expect(hostedPlanCapacity('unknown-plan', {})).toEqual(PLAN_HOSTED_CAPACITY.free);
  });

  it('takes the install override from the environment, row by row', () => {
    const env = { [HOSTED_PLAN_CAPACITY_ENV]: JSON.stringify({ pro: { includedHoursPerSeat: { small: 10, large: 2 }, maxConcurrentRunners: 4, monthlyCeilingHours: 100 }, free: { hostedEnvironments: true } }) };
    expect(hostedPlanCapacity('pro', env)).toMatchObject({ includedHoursPerSeat: { small: 10, large: 2 }, maxConcurrentRunners: 4, monthlyCeilingHours: 100, maxWorkspaces: null });
    expect(hostedPlanCapacity('free', env).hostedEnvironments).toBe(true);
    expect(hostedPlanCapacity('pro', { [HOSTED_PLAN_CAPACITY_ENV]: 'not json' })).toEqual(PLAN_HOSTED_CAPACITY.pro);
  });

  it('lets an organization tighten its own numbers, never loosen them', () => {
    const env = { [HOSTED_PLAN_CAPACITY_ENV]: JSON.stringify({ pro: { maxConcurrentRunners: 4, monthlyCeilingHours: 100 } }) };
    expect(orgHostedCapacity({ plan: 'pro', settings: { hostedCapacity: { maxConcurrentRunners: 1, monthlyCeilingHours: 500 } } }, env)).toMatchObject({
      maxConcurrentRunners: 1,
      monthlyCeilingHours: 100,
    });
    // No plan ceiling: the organization's own is the ceiling.
    expect(orgHostedCapacity({ plan: 'pro', settings: { hostedCapacity: { monthlyCeilingHours: 20 } } }, {}).monthlyCeilingHours).toBe(20);
  });

  it('counts the allowance per seat, in minutes', () => {
    expect(includedMinutes(hostedPlanCapacity('pro', {}), 3)).toEqual({ small: 40 * 60 * 3 });
    expect(includedMinutes(hostedPlanCapacity('enterprise', {}), 3)).toBeNull();
  });

  it('keeps every number in the plan row, not in the code that reads it', () => {
    const provider = readFileSync(join(__dirname, '..', 'plan-hosted-capacity.provider.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const literals = (provider.match(/\b\d+\b/g) ?? []).filter((n) => !['0', '1', '60'].includes(n));
    expect(literals).toEqual([]);
  });
});

describe('PlanHostedCapacityProvider', () => {
  const settings = new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, {});
  const fallback = DEFAULT_HOSTED_RUNNER_SETTINGS.capacity;
  const config = (stripe: boolean): any => ({ get: (k: string) => (k === 'STRIPE_SECRET_KEY' && stripe ? 'sk_test_x' : undefined) });
  const repo = (org: any): any => ({ findOne: jest.fn(async () => org) });

  it('fills a plan from its row, numbers the row leaves open from the install settings', async () => {
    const org = { id: 'o', plan: 'pro', billingInfo: { seats: 2, stripeSubscriptionId: 'sub_1' }, settings: {} };
    const cap = await new PlanHostedCapacityProvider(repo(org), config(true), settings).capacityFor('o');
    expect(cap).toEqual({
      plan: 'pro',
      hostedEnvironments: true,
      maxConcurrentRunners: fallback.maxConcurrentRunners,
      maxWorkspaces: fallback.maxWorkspaces,
      resourceClasses: null,
      includedMinutes: { small: 40 * 60 * 2 },
      monthlyCeilingMinutes: null,
      billed: true,
    });
  });

  it('gives a Free organization no hosted machines', async () => {
    const cap = await new PlanHostedCapacityProvider(repo({ id: 'o', plan: 'free', billingInfo: {} }), config(true), settings).capacityFor('o');
    expect(cap).toMatchObject({ hostedEnvironments: false, maxConcurrentRunners: 0, maxWorkspaces: 0, billed: false });
  });

  it('bills nothing for a plan with no subscription behind it', async () => {
    const cap = await new PlanHostedCapacityProvider(repo({ id: 'o', plan: 'pro', billingInfo: {} }), config(true), settings).capacityFor('o');
    expect(cap.billed).toBe(false);
  });

  it('fails closed when the organization cannot be read', async () => {
    const broken: any = { findOne: jest.fn(async () => { throw new Error('db down'); }) };
    expect(await new PlanHostedCapacityProvider(broken, config(true), settings).capacityFor('o')).toMatchObject({ hostedEnvironments: false, maxConcurrentRunners: 0 });
    expect(await new PlanHostedCapacityProvider(repo(null), config(true), settings).capacityFor('o')).toMatchObject({ hostedEnvironments: false });
  });

  it('applies no plan on an install that sells none (no Stripe): the install settings, for every organization', async () => {
    const r = repo({ id: 'o', plan: 'free' });
    const cap = await new PlanHostedCapacityProvider(r, config(false), settings).capacityFor('o');
    expect(cap).toEqual({ maxConcurrentRunners: fallback.maxConcurrentRunners, maxWorkspaces: fallback.maxWorkspaces, resourceClasses: fallback.resourceClasses ?? null });
    expect(r.findOne).not.toHaveBeenCalled();
  });
});
