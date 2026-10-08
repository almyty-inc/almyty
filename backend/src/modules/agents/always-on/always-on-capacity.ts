/**
 * How much an organization's always-on agents may wake (docs/always-on.md,
 * "Limits"). Configuration, never a constant in the code that uses it:
 *
 * 1. The plan catalog below seeds a row per plan.
 * 2. The install overrides any of it with ALWAYS_ON_PLAN_CAPACITY, JSON keyed
 *    by plan, e.g. `{"free":{"timerFloorMinutes":10},"pro":{"includedAgents":5}}`.
 * 3. An organization may tighten its own (`settings.alwaysOn`): a longer
 *    floor, fewer wakes an hour, fewer agents. Never looser, because the
 *    workers are the install's.
 *
 * Capacity is not an entitlement and stays out of the license token.
 */

export interface AlwaysOnCapacity {
  /** The shortest timer an agent may have, in minutes. */
  timerFloorMinutes: number;
  /** The most wakes an agent may act on in an hour before it pauses itself. */
  maxWakesPerHour: number;
  /**
   * Always-on agents an organization may have on at once. Null is no limit.
   * Turning one more on is refused; an agent beyond it after the plan
   * changed (fewer included, a lapse) is paused with CAPACITY_EXHAUSTED at
   * its next wake, the last turned on first, and turned back on when there
   * is room again (AlwaysOnService.resumeWithinCapacity).
   */
  includedAgents: number | null;
}

/** The seeded plan catalog. */
export const ALWAYS_ON_PLAN_DEFAULTS: Record<string, AlwaysOnCapacity> = {
  free: { timerFloorMinutes: 15, maxWakesPerHour: 6, includedAgents: null },
  pro: { timerFloorMinutes: 5, maxWakesPerHour: 12, includedAgents: 3 },
  business: { timerFloorMinutes: 5, maxWakesPerHour: 12, includedAgents: null },
  enterprise: { timerFloorMinutes: 5, maxWakesPerHour: 12, includedAgents: null },
};

export const ALWAYS_ON_CAPACITY_ENV = 'ALWAYS_ON_PLAN_CAPACITY';

type Env = Record<string, string | undefined>;

function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function planKey(plan: string | null | undefined): string {
  const key = String(plan || 'free').toLowerCase();
  return key;
}

/** The install's row for a plan: the catalog, overridden by the environment. */
export function planCapacity(plan: string | null | undefined, env: Env = process.env): AlwaysOnCapacity {
  const key = planKey(plan);
  const seeded = ALWAYS_ON_PLAN_DEFAULTS[key] ?? ALWAYS_ON_PLAN_DEFAULTS.free;
  const out: AlwaysOnCapacity = { ...seeded };
  const raw = env[ALWAYS_ON_CAPACITY_ENV];
  if (!raw || !raw.trim()) return out;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const row = parsed && typeof parsed === 'object' ? parsed[key] : null;
  if (!row || typeof row !== 'object') return out;
  const floor = positiveInt(row.timerFloorMinutes);
  if (floor !== null) out.timerFloorMinutes = floor;
  const wakes = positiveInt(row.maxWakesPerHour);
  if (wakes !== null) out.maxWakesPerHour = wakes;
  if (row.includedAgents === null) out.includedAgents = null;
  else {
    const agents = positiveInt(row.includedAgents);
    if (agents !== null) out.includedAgents = agents;
  }
  return out;
}

/** An organization's capacity: its plan's row, tightened by its own settings. */
export function alwaysOnCapacity(
  org: { plan?: string | null; settings?: { alwaysOn?: Partial<Record<keyof AlwaysOnCapacity, unknown>> } | null } | null | undefined,
  env: Env = process.env,
): AlwaysOnCapacity {
  const base = planCapacity(org?.plan, env);
  const own = org?.settings?.alwaysOn;
  if (!own || typeof own !== 'object') return base;
  const out = { ...base };
  const floor = positiveInt(own.timerFloorMinutes);
  if (floor !== null) out.timerFloorMinutes = Math.max(floor, base.timerFloorMinutes);
  const wakes = positiveInt(own.maxWakesPerHour);
  if (wakes !== null) out.maxWakesPerHour = Math.min(wakes, base.maxWakesPerHour);
  const agents = positiveInt(own.includedAgents);
  if (agents !== null) out.includedAgents = base.includedAgents === null ? agents : Math.min(agents, base.includedAgents);
  return out;
}

/** The timer an agent actually gets: what it asked for, never under the floor. */
export function effectiveTimerMinutes(requested: number, capacity: AlwaysOnCapacity): number {
  return Math.max(Math.floor(requested), capacity.timerFloorMinutes);
}

/** The wakes an hour an agent actually gets: what it asked for, never over the plan's. */
export function effectiveWakesPerHour(requested: number | null | undefined, capacity: AlwaysOnCapacity): number {
  const n = positiveInt(requested);
  return n === null ? capacity.maxWakesPerHour : Math.min(n, capacity.maxWakesPerHour);
}
