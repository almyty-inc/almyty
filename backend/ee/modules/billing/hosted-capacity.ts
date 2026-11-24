/**
 * Plan capacity for hosted runners (docs/design/hosted-runners-and-always-on.md,
 * "Capacity"). Every number is data, never a constant in the code that reads
 * it (Decision 5), in the same three layers Always on uses
 * (src/modules/agents/always-on/always-on-capacity.ts):
 *
 * 1. PLAN_HOSTED_CAPACITY below seeds a row per plan.
 * 2. The install overrides any of it with HOSTED_PLAN_CAPACITY, JSON keyed by
 *    plan, e.g. `{"pro":{"includedHoursPerSeat":{"small":40},"maxConcurrentRunners":2,"monthlyCeilingUsd":50}}`.
 * 3. An organization may tighten its own (`settings.hostedCapacity`), never
 *    loosen it, because the machines are the install's.
 *
 * A null number means "the install's hosted runner settings decide"
 * (`HOSTED_RUNNERS_SETTINGS` capacity), so nothing here invents a limit the
 * owner has not set. Capacity is not an entitlement and stays out of the
 * license token.
 */
import { PLAN_BUSINESS, PLAN_ENTERPRISE, PLAN_FREE, PLAN_PRO } from './billing.constants';

export interface HostedPlanCapacity {
  /** Whether the plan may create hosted environments at all. Free may not. */
  hostedEnvironments: boolean;
  /** Hosted machines running at once; null: the install's setting. */
  maxConcurrentRunners: number | null;
  /** Persistent workspaces kept (running or parked); null: the install's setting. */
  maxWorkspaces: number | null;
  /** Machine sizes the plan may use; null: every size the install offers. */
  resourceClasses: string[] | null;
  /**
   * Runner-hours included each month per seat, per machine size. A size not
   * listed has none included: every minute of it is overage. Null: no
   * allowance is tracked (Enterprise: contract terms, nothing to Stripe).
   */
  includedHoursPerSeat: Record<string, number> | null;
  /** Runner-hours a month after which wakes are refused; null: no ceiling. */
  monthlyCeilingHours: number | null;
  /**
   * US dollars of overage a month (minutes beyond the allowance, at each
   * size's per-minute price in STRIPE_HOSTED_METERS) after which wakes
   * are refused. 0: nothing beyond the included hours. Null: no ceiling.
   */
  monthlyCeilingUsd: number | null;
  /** Whether minutes beyond the allowance are reported to Stripe as overage. */
  billed: boolean;
}

export const HOSTED_PLAN_CAPACITY_ENV = 'HOSTED_PLAN_CAPACITY';

/**
 * The seeded plan catalog: the plan limits the owner approved
 * (2026-11-24). Pro: 2 machines at once, 10 workspaces, small and medium
 * machines, 40 small-machine hours per seat a month, $50 of overage a
 * month. Business: 5, 50, every size, 100 small-machine hours per seat,
 * $250. Medium and large hours are never included: every minute of them
 * is overage.
 */
export const PLAN_HOSTED_CAPACITY: Record<string, HostedPlanCapacity> = {
  [PLAN_FREE]: {
    hostedEnvironments: false,
    maxConcurrentRunners: 0,
    maxWorkspaces: 0,
    resourceClasses: [],
    includedHoursPerSeat: {},
    monthlyCeilingHours: 0,
    monthlyCeilingUsd: 0,
    billed: false,
  },
  [PLAN_PRO]: {
    hostedEnvironments: true,
    maxConcurrentRunners: 2,
    maxWorkspaces: 10,
    resourceClasses: ['small', 'medium'],
    includedHoursPerSeat: { small: 40 },
    monthlyCeilingHours: null,
    monthlyCeilingUsd: 50,
    billed: true,
  },
  [PLAN_BUSINESS]: {
    hostedEnvironments: true,
    maxConcurrentRunners: 5,
    maxWorkspaces: 50,
    resourceClasses: null,
    includedHoursPerSeat: { small: 100 },
    monthlyCeilingHours: null,
    monthlyCeilingUsd: 250,
    billed: true,
  },
  // Enterprise is metered against its contract: recorded and shown, never
  // sent to Stripe. Its limits are the install's hosted runner settings.
  [PLAN_ENTERPRISE]: {
    hostedEnvironments: true,
    maxConcurrentRunners: null,
    maxWorkspaces: null,
    resourceClasses: null,
    includedHoursPerSeat: null,
    monthlyCeilingHours: null,
    monthlyCeilingUsd: null,
    billed: false,
  },
};

type Env = Record<string, string | undefined>;

function nonNegative(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function hoursMap(raw: unknown): Record<string, number> | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = nonNegative(v);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** The install's row for a plan: the catalog, overridden by the environment. */
export function hostedPlanCapacity(plan: string | null | undefined, env: Env = process.env): HostedPlanCapacity {
  const key = String(plan || PLAN_FREE).toLowerCase();
  const seeded = PLAN_HOSTED_CAPACITY[key] ?? PLAN_HOSTED_CAPACITY[PLAN_FREE];
  const out: HostedPlanCapacity = {
    ...seeded,
    resourceClasses: seeded.resourceClasses ? [...seeded.resourceClasses] : null,
    includedHoursPerSeat: seeded.includedHoursPerSeat ? { ...seeded.includedHoursPerSeat } : null,
  };
  const raw = env[HOSTED_PLAN_CAPACITY_ENV];
  if (!raw || !raw.trim()) return out;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const row = parsed && typeof parsed === 'object' ? parsed[key] : null;
  if (!row || typeof row !== 'object') return out;
  if (typeof row.hostedEnvironments === 'boolean') out.hostedEnvironments = row.hostedEnvironments;
  if (typeof row.billed === 'boolean') out.billed = row.billed;
  for (const field of ['maxConcurrentRunners', 'maxWorkspaces', 'monthlyCeilingHours', 'monthlyCeilingUsd'] as const) {
    if (row[field] === null) out[field] = null;
    else {
      const n = nonNegative(row[field]);
      if (n !== null) out[field] = n;
    }
  }
  if (row.resourceClasses === null) out.resourceClasses = null;
  else if (Array.isArray(row.resourceClasses)) out.resourceClasses = row.resourceClasses.filter((c: unknown) => typeof c === 'string');
  const hours = hoursMap(row.includedHoursPerSeat);
  if (hours !== undefined) out.includedHoursPerSeat = hours;
  return out;
}

/** What an organization may set for itself: only tighter. */
export interface OwnHostedCapacity {
  maxConcurrentRunners?: unknown;
  maxWorkspaces?: unknown;
  monthlyCeilingHours?: unknown;
  monthlyCeilingUsd?: unknown;
}

function tighter(own: unknown, base: number | null): number | null {
  const n = nonNegative(own);
  if (n === null) return base;
  return base === null ? n : Math.min(n, base);
}

/** An organization's row: its plan's, tightened by its own settings. */
export function orgHostedCapacity(
  org: { plan?: string | null; settings?: { hostedCapacity?: OwnHostedCapacity | null } | null } | null | undefined,
  env: Env = process.env,
): HostedPlanCapacity {
  const base = hostedPlanCapacity(org?.plan, env);
  const own = org?.settings?.hostedCapacity;
  if (!own || typeof own !== 'object') return base;
  return {
    ...base,
    maxConcurrentRunners: tighter(own.maxConcurrentRunners, base.maxConcurrentRunners),
    maxWorkspaces: tighter(own.maxWorkspaces, base.maxWorkspaces),
    monthlyCeilingHours: tighter(own.monthlyCeilingHours, base.monthlyCeilingHours),
    monthlyCeilingUsd: tighter(own.monthlyCeilingUsd, base.monthlyCeilingUsd),
  };
}

/** Included minutes this month per size: hours per seat times seats. Null when none are tracked. */
export function includedMinutes(row: HostedPlanCapacity, seats: number): Record<string, number> | null {
  if (!row.includedHoursPerSeat) return null;
  const n = Math.max(1, Math.floor(seats) || 1);
  const out: Record<string, number> = {};
  for (const [cls, hours] of Object.entries(row.includedHoursPerSeat)) out[cls] = hours * 60 * n;
  return out;
}
