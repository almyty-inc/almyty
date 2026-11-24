import { ForbiddenException } from '@nestjs/common';

import { EnvironmentsService } from '../environments.service';
import { EnvironmentInsightsService } from '../environment-insights.service';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../hosted-runner-settings';
import { HostedRunnersService } from '../hosted-runners.service';
import { CapacityExhaustedError, HOSTED_NOT_INCLUDED, HostedCapacity, overageUsd, spendCeilingReached } from '../hosted-capacity.provider';

/**
 * Plan capacity reaches hosted runners through HOSTED_CAPACITY_PROVIDER
 * (filled from `ee`). What the plan says is enforced here: a plan without
 * hosted machines cannot make an environment or wake one, and a wake past
 * the month's ceiling is refused. The Hosted tab reads used-and-limit for
 * each number from GET /environments/capacity.
 */
const settings = new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, { HOSTED_RUNNERS_ENABLED: 'true' });
const ORG = 'org-1';

function hostedService(capacity: HostedCapacity, minutes: Record<string, number> = {}, running = 0) {
  const provider = { capacityFor: jest.fn(async () => capacity) };
  const hostedRunners: any = { update: jest.fn(async () => undefined) };
  const queue: any = { add: jest.fn(async () => undefined) };
  const service = new HostedRunnersService(hostedRunners, {} as any, {} as any, {} as any, queue, {} as any, settings, {} as any, provider);
  jest.spyOn(service, 'runningCount').mockResolvedValue(running);
  jest.spyOn(service, 'minutesThisMonth').mockResolvedValue(minutes);
  return { service, hostedRunners };
}

const parked = () => ({ id: 'hr-1', organizationId: ORG, desired: { replicas: 0, resourceClass: 'small' } }) as any;
const PRO: HostedCapacity = { maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null, plan: 'pro', hostedEnvironments: true, monthlyCeilingMinutes: 600 };

describe('plan capacity on hosted machines', () => {
  it('refuses to wake a machine on a plan without hosted machines', async () => {
    const { service, hostedRunners } = hostedService({ ...PRO, plan: 'free', hostedEnvironments: false, maxConcurrentRunners: 0 });
    const err = await service.ensureAwake(parked()).catch((e) => e);
    expect(err).toBeInstanceOf(CapacityExhaustedError);
    expect(err.message).toBe(HOSTED_NOT_INCLUDED);
    expect(hostedRunners.update).not.toHaveBeenCalled();
  });

  it('refuses a wake once the month has reached its ceiling, and allows one below it', async () => {
    const over = hostedService(PRO, { small: 590, large: 10 });
    await expect(over.service.ensureAwake(parked())).rejects.toThrow(/10 hours this month, its monthly limit/);
    expect(over.hostedRunners.update).not.toHaveBeenCalled();

    const under = hostedService(PRO, { small: 300 });
    const hr = await under.service.ensureAwake(parked());
    expect(hr.desired.replicas).toBe(1);
    expect(under.hostedRunners.update).toHaveBeenCalled();
  });

  it('has no ceiling where the capacity names none (no plan)', async () => {
    const { service } = hostedService({ maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null }, { small: 1e6 });
    await expect(service.ensureAwake(parked())).resolves.toBeTruthy();
  });

  it('still refuses past the concurrent machines limit', async () => {
    const { service } = hostedService(PRO, {}, 2);
    await expect(service.ensureAwake(parked())).rejects.toThrow(/2 hosted machines at once/);
  });
});

describe('the monthly dollar ceiling', () => {
  const PRICED: HostedCapacity = {
    ...PRO,
    monthlyCeilingMinutes: null,
    monthlyCeilingUsd: 50,
    includedMinutes: { small: 2400 },
    usdPerMinute: { small: 0.001, medium: 0.002, large: 0.004 },
  };

  it('counts only minutes beyond the included ones, at each size\'s price', () => {
    expect(overageUsd({ small: 2400, medium: 100 }, { small: 2400 }, PRICED.usdPerMinute)).toBeCloseTo(0.2);
    expect(overageUsd({ small: 3400 }, { small: 2400 }, PRICED.usdPerMinute)).toBeCloseTo(1);
    // A size with no price adds nothing.
    expect(overageUsd({ xlarge: 1e6 }, {}, PRICED.usdPerMinute)).toBe(0);
  });

  it('refuses a wake once the overage reaches the ceiling, and allows one below it', async () => {
    // 12,500 medium minutes at $0.002 = $25; 6,250 large at $0.004 = $25.
    const over = hostedService(PRICED, { small: 2000, medium: 12_500, large: 6_250 });
    await expect(over.service.ensureAwake(parked())).rejects.toThrow('used $50.00 beyond the included hours this month');
    expect(over.hostedRunners.update).not.toHaveBeenCalled();

    // Far past the included small hours is fine until the dollars reach the ceiling.
    const under = hostedService(PRICED, { small: 2400 + 40_000 });
    await expect(under.service.ensureAwake(parked())).resolves.toBeTruthy();
  });

  it('allows the included hours and nothing beyond them at a ceiling of 0', async () => {
    const zero = { ...PRICED, monthlyCeilingUsd: 0 };
    await expect(hostedService(zero, { small: 2400 }).service.ensureAwake(parked())).resolves.toBeTruthy();
    await expect(hostedService(zero, { small: 2401 }).service.ensureAwake(parked())).rejects.toThrow(CapacityExhaustedError);
    expect(spendCeilingReached(0, null)).toBe(false);
  });
});

describe('making an environment on a plan without hosted machines', () => {
  function environments(capacity: HostedCapacity) {
    const rows: any = {
      create: (x: any) => ({ ...x }),
      save: jest.fn(async (x: any) => ({ id: 'env-1', ...x })),
      findOne: jest.fn(async () => null),
    };
    const hosted: any = { refuseWhenDisabled: () => undefined, capacityFor: async () => capacity };
    const accessPolicy: any = { assertCanScopeToTeam: jest.fn(async () => undefined) };
    const publisher: any = { publishEnvironment: jest.fn(async () => []) };
    return { service: new EnvironmentsService(rows, {} as any, accessPolicy, settings, hosted, publisher), rows };
  }
  const dto = { name: 'app', image: { base: 'standard' } } as any;

  it('is refused in plain words, and nothing is saved', async () => {
    const { service, rows } = environments({ ...PRO, plan: 'free', hostedEnvironments: false });
    const err = await service.create(dto, 'user-1', ORG).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe(HOSTED_NOT_INCLUDED);
    expect(rows.save).not.toHaveBeenCalled();
  });

  it('is allowed on a plan with them', async () => {
    const { service, rows } = environments(PRO);
    await service.create(dto, 'user-1', ORG);
    expect(rows.save).toHaveBeenCalled();
  });
});

describe('GET /environments/capacity: used and limit for each number', () => {
  it('reports machines, workspaces, minutes per size against the allowance, the ceiling and hosted always-on agents', async () => {
    const hosted: any = {
      capacityFor: async () => ({ ...PRO, billed: true, includedMinutes: { small: 2400 } }),
      runningCount: async () => 1,
      workspaceCount: async () => 3,
      minutesThisMonth: async () => ({ small: 90, large: 30 }),
    };
    const dataSource: any = {
      query: jest.fn(async (sql: string) =>
        sql.includes('FROM organizations') ? [{ plan: 'pro', settings: {} }] : [{ n: 2 }],
      ),
    };
    const insights = new EnvironmentInsightsService(settings, hosted, {} as any, {} as any, dataSource);
    const view = await insights.capacity(ORG);
    expect(view).toEqual({
      plan: 'pro',
      hostedEnvironments: true,
      billed: true,
      machinesRunning: { used: 1, limit: 2 },
      workspacesKept: { used: 3, limit: 10 },
      resourceClasses: null,
      minutesThisMonth: {
        used: 120,
        ceiling: 600,
        byClass: [
          { resourceClass: 'large', used: 30, included: 0, usdPerMinute: null },
          { resourceClass: 'small', used: 90, included: 2400, usdPerMinute: null },
        ],
      },
      spendThisMonth: { usd: 0, ceilingUsd: null },
      alwaysOnHosted: { used: 2, limit: 3 },
    });
  });

  it('reports no allowance and no ceiling where no plan applies', async () => {
    const hosted: any = {
      capacityFor: async () => ({ maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null }),
      runningCount: async () => 0,
      workspaceCount: async () => 0,
      minutesThisMonth: async () => ({}),
    };
    const dataSource: any = { query: jest.fn(async (sql: string) => (sql.includes('FROM organizations') ? [{ plan: 'free' }] : [{ n: 0 }])) };
    const view = await new EnvironmentInsightsService(settings, hosted, {} as any, {} as any, dataSource).capacity(ORG);
    expect(view.plan).toBeNull();
    expect(view.billed).toBe(false);
    expect(view.minutesThisMonth).toEqual({ used: 0, ceiling: null, byClass: [] });
    expect(view.spendThisMonth).toEqual({ usd: 0, ceilingUsd: null });
  });

  it('reports the dollars used beyond the included hours against the dollar ceiling, and each size\'s price', async () => {
    const hosted: any = {
      capacityFor: async () => ({ ...PRO, monthlyCeilingMinutes: null, monthlyCeilingUsd: 50, includedMinutes: { small: 2400 }, usdPerMinute: { small: 0.001, medium: 0.002 }, billed: true }),
      runningCount: async () => 0,
      workspaceCount: async () => 0,
      minutesThisMonth: async () => ({ small: 3400, medium: 500 }),
    };
    const dataSource: any = { query: jest.fn(async (sql: string) => (sql.includes('FROM organizations') ? [{ plan: 'pro' }] : [{ n: 0 }])) };
    const view = await new EnvironmentInsightsService(settings, hosted, {} as any, {} as any, dataSource).capacity(ORG);
    // 1000 small minutes over at $0.001, 500 medium minutes (none included) at $0.002.
    expect(view.spendThisMonth.ceilingUsd).toBe(50);
    expect(view.spendThisMonth.usd).toBeCloseTo(2);
    expect(view.minutesThisMonth.byClass).toEqual([
      { resourceClass: 'medium', used: 500, included: 0, usdPerMinute: 0.002 },
      { resourceClass: 'small', used: 3400, included: 2400, usdPerMinute: 0.001 },
    ]);
  });
});
