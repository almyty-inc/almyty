import { HostedRunnerSettingsService } from './hosted-runner-settings';

/**
 * How much hosted capacity an organization has: how many hosted runners
 * may run at once, how many persistent workspaces it may keep, and which
 * resource classes it may use (null: any configured class). The plan
 * fields are filled only where a plan applies (the billing module in `ee`);
 * the Apache build leaves them out, which means no plan limit.
 */
export interface HostedCapacity {
  maxConcurrentRunners: number;
  maxWorkspaces: number;
  resourceClasses: string[] | null;
  /** The plan these numbers come from; absent without a plan. */
  plan?: string | null;
  /** False when the plan has no hosted environments (creating one is refused). */
  hostedEnvironments?: boolean;
  /** Runner-minutes included this month per resource class; absent or null: no allowance tracked. */
  includedMinutes?: Record<string, number> | null;
  /** Runner-minutes a month after which wakes are refused; absent or null: no ceiling. */
  monthlyCeilingMinutes?: number | null;
  /** US dollars of overage a month after which wakes are refused; absent or null: no ceiling. */
  monthlyCeilingUsd?: number | null;
  /** The price per minute of each size, in US dollars, where the install gives one. */
  usdPerMinute?: Record<string, number> | null;
  /** Whether minutes beyond the allowance are billed as overage. */
  billed?: boolean;
}
/**
 * The seam plan capacity plugs into. The Apache build answers from the
 * hosted runner settings (`capacity`), the same for every organization;
 * the billing module in `ee` replaces it with per-plan numbers (phase 3),
 * the way OrgLicenseResolver is filled. Numbers live in data either way.
 */
export interface HostedCapacityProvider {
  capacityFor(organizationId: string): Promise<HostedCapacity>;
}

export const HOSTED_CAPACITY_PROVIDER = Symbol('HOSTED_CAPACITY_PROVIDER');

/** The capacity the settings give every organization. */
export class SettingsCapacityProvider implements HostedCapacityProvider {
  constructor(private readonly settings: HostedRunnerSettingsService) {}

  async capacityFor(_organizationId: string): Promise<HostedCapacity> {
    const { maxConcurrentRunners, maxWorkspaces, resourceClasses } = this.settings.current.capacity;
    return { maxConcurrentRunners, maxWorkspaces, resourceClasses: resourceClasses ?? null };
  }
}

/** Why a wake or a new workspace was refused. */
export class CapacityExhaustedError extends Error {
  readonly code = 'CAPACITY_EXHAUSTED';
  constructor(message: string) {
    super(message);
    this.name = 'CapacityExhaustedError';
  }
}

/** What a create or a wake hears on a plan without hosted machines. */
export const HOSTED_NOT_INCLUDED =
  'Hosted machines are not part of your plan. Register a machine of your own as a runner, or upgrade.';

/** What a wake hears once the month's ceiling is reached. */
export function ceilingReached(ceilingMinutes: number): string {
  const hours = Math.round((ceilingMinutes / 60) * 10) / 10;
  return `Your organization's hosted machines have run ${hours} hours this month, its monthly limit. They start again next month, or when an admin raises the limit.`;
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** A dollar amount as the product writes it: $50.00. */
export function formatUsd(usd: number): string {
  return USD.format(usd);
}

/**
 * Dollars of overage this month: for each size, the minutes beyond its
 * included minutes times its per-minute price. A size with no price adds
 * nothing; with no allowance tracked (null), every minute is overage.
 */
export function overageUsd(
  minutes: Record<string, number>,
  included: Record<string, number> | null | undefined,
  prices: Record<string, number> | null | undefined,
): number {
  let total = 0;
  for (const [cls, used] of Object.entries(minutes)) {
    const price = prices?.[cls];
    if (!price) continue;
    total += Math.max(0, used - (included?.[cls] ?? 0)) * price;
  }
  return total;
}

/** Whether the month's dollar ceiling stops new wakes. A ceiling of 0 allows the included hours and nothing beyond them. */
export function spendCeilingReached(spentUsd: number, ceilingUsd: number | null | undefined): boolean {
  if (ceilingUsd === null || ceilingUsd === undefined) return false;
  return spentUsd >= ceilingUsd && (ceilingUsd > 0 || spentUsd > 0);
}

/** What a wake hears once the month's dollar ceiling is reached. */
export function spendCeilingMessage(ceilingUsd: number): string {
  return `Your organization's hosted machines have used ${formatUsd(ceilingUsd)} beyond the included hours this month, its monthly limit. They start again next month, or when an admin raises the limit.`;
}