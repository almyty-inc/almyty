import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { Logger } from '@nestjs/common';
import { In, IsNull, LessThan, LessThanOrEqual, Or, Repository } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { writeRun } from './run-event-writer';

/**
 * Run leases, durable runs step 3 (docs/design/durable-runs.md).
 *
 * A worker processes a step of a run only while it holds the run's lease:
 * it claims the run (free or lapsed lease, due), renews the lease while it
 * works, and lets it go when the step returns. Every write the step makes
 * is fenced on the lease's token (`heldBy`), so a worker whose lease lapsed
 * and was taken over cannot write: its commit matches no row. A claim of a
 * lapsed lease is a takeover, counted in `attempt` and recorded on the
 * run's log as `lease_taken_over`. The queue only nudges: a job that finds
 * the run held, not due, or past the step it was queued for does nothing.
 *
 * All of it goes through writeRun. A claim, a renewal and a release change
 * lease columns only, so they append nothing; a takeover is on the log.
 */

/**
 * What processing a step came to: the run goes on, finished, waits (a
 * person, a sleep), or was not claimed ('held': another worker holds it,
 * it is not due, or it has moved past the step a nudge was queued for).
 */
export type StepOutcome = 'continue' | 'done' | 'waiting' | 'held';
export interface RunLeaseConfig {
  /** How long a claim or a renewal holds the run. */
  leaseMs: number;
  /** How often the holder renews while the step runs. */
  renewMs: number;
  /** How often the wake sweep looks for runs that are due and nobody holds. */
  sweepIntervalMs: number;
  /** How long past due a run must be before the sweep nudges it (its own nudge had that long). */
  wakeGraceMs: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Read from the environment each time, with defaults; nothing here is fixed in code. */
export function runLeaseConfig(env: NodeJS.ProcessEnv = process.env): RunLeaseConfig {
  const leaseMs = positive(env.RUN_LEASE_MS, 60_000);
  // A renewal has to land before the lease lapses: at most half of it.
  const renewMs = Math.min(positive(env.RUN_LEASE_RENEW_MS, Math.floor(leaseMs / 3)), Math.floor(leaseMs / 2));
  return {
    leaseMs,
    renewMs: Math.max(1, renewMs),
    sweepIntervalMs: positive(env.RUN_WAKE_SWEEP_INTERVAL_MS, 15_000),
    wakeGraceMs: positive(env.RUN_WAKE_GRACE_MS, 30_000),
  };
}

/** Statuses a worker may claim a run in. A run waiting on a person, or finished, is not claimed. */
export const CLAIMABLE_STATUSES: AgentRunStatus[] = [AgentRunStatus.PENDING, AgentRunStatus.RUNNING, AgentRunStatus.SLEEPING];

const TERMINAL: string[] = [AgentRunStatus.COMPLETED, AgentRunStatus.FAILED, AgentRunStatus.CANCELLED, AgentRunStatus.TIMEOUT];

const LEASE_READ: Array<keyof AgentRun> = ['status', 'currentStep', 'nextWakeAt', 'leaseOwner', 'leaseExpiresAt', 'attempt'];

const WORKER = `${hostname()}:${process.pid}`;

/** A token for one claim: this worker, and this claim of it, so a stale step of the same process is fenced too. */
export function newLeaseToken(): string {
  return `${WORKER}:${randomUUID()}`;
}

export type RunClaim =
  | { claimed: true; owner: string; expiresAt: Date; attempt: number; takenOver: boolean }
  | { claimed: false; reason: 'missing' | 'done' | 'held' | 'not_due' | 'moved_on' };

/**
 * Claim a run for one step: its status claimable, due (`nextWakeAt` passed,
 * or none), its lease free or lapsed and, when `step` is given, still at
 * that step (a nudge queued for a step already processed is stale). A
 * lapsed lease is taken over: `attempt` + 1 and `lease_taken_over` on the
 * log. Not claimed: why, for the caller to log or act on.
 */
export async function claimRun(
  runs: Repository<AgentRun>,
  runId: string,
  options: { leaseMs: number; step?: number; now?: Date },
): Promise<RunClaim> {
  const now = options.now ?? new Date();
  const owner = newLeaseToken();
  const expiresAt = new Date(now.getTime() + options.leaseMs);
  const due = {
    id: runId,
    status: In(CLAIMABLE_STATUSES),
    nextWakeAt: Or(IsNull(), LessThanOrEqual(now)),
    leaseExpiresAt: Or(IsNull(), LessThan(now)),
    ...(options.step !== undefined && options.step !== null ? { currentStep: options.step } : {}),
  };

  let lapsed: Pick<AgentRun, 'leaseOwner' | 'leaseExpiresAt' | 'attempt'> | null = null;
  const free = await writeRun(
    runs,
    due,
    (row) => {
      if (row.leaseOwner) {
        lapsed = { leaseOwner: row.leaseOwner, leaseExpiresAt: row.leaseExpiresAt, attempt: row.attempt ?? 0 };
        return null;
      }
      return { leaseOwner: owner, leaseExpiresAt: expiresAt };
    },
    [],
    { select: LEASE_READ },
  );
  if (free) return { claimed: true, owner, expiresAt, attempt: free.attempt ?? 0, takenOver: false };

  if (lapsed) {
    const before = lapsed as Pick<AgentRun, 'leaseOwner' | 'leaseExpiresAt' | 'attempt'>;
    const attempt = (before.attempt ?? 0) + 1;
    // Only the lease that lapsed: another claim that got there first changed the owner.
    const taken = await writeRun(
      runs,
      { ...due, leaseOwner: before.leaseOwner as string },
      { leaseOwner: owner, leaseExpiresAt: expiresAt, attempt },
      [{ type: 'lease_taken_over', step: null, payload: { attempt, lapsedAt: before.leaseExpiresAt ? new Date(before.leaseExpiresAt).toISOString() : null } }],
    );
    if (taken) return { claimed: true, owner, expiresAt, attempt, takenOver: true };
  }

  return { claimed: false, reason: await whyNotClaimed(runs, runId, options.step, now) };
}

async function whyNotClaimed(runs: Repository<AgentRun>, runId: string, step: number | undefined, now: Date): Promise<'missing' | 'done' | 'held' | 'not_due' | 'moved_on'> {
  const row = await runs.findOne({ where: { id: runId }, select: Object.fromEntries(['id', ...LEASE_READ].map((c) => [c, true])) as any });
  if (!row) return 'missing';
  if (TERMINAL.includes(row.status)) return 'done';
  if (step !== undefined && step !== null && row.currentStep !== step) return 'moved_on';
  if (row.leaseOwner && row.leaseExpiresAt && new Date(row.leaseExpiresAt).getTime() >= now.getTime()) return 'held';
  return 'not_due';
}

/** Extend the lease this claim holds. False when it is no longer held: lapsed and taken over, or let go. */
export async function renewRunLease(runs: Repository<AgentRun>, runId: string, owner: string, leaseMs: number, now = new Date()): Promise<boolean> {
  const renewed = await writeRun(runs, { id: runId, leaseOwner: owner }, { leaseExpiresAt: new Date(now.getTime() + leaseMs) }, [], { select: LEASE_READ });
  return !!renewed;
}

/** Let the lease go, if this claim still holds it. */
export async function releaseRunLease(runs: Repository<AgentRun>, runId: string, owner: string): Promise<boolean> {
  const released = await writeRun(runs, { id: runId, leaseOwner: owner }, { leaseOwner: null, leaseExpiresAt: null }, [], { select: LEASE_READ });
  return !!released;
}

/**
 * The fence for a write made under a lease: add it to the write's `where`.
 * A run object loaded under a claim carries the claim's token
 * (`leaseOwner`); one that is not leased adds nothing.
 */
export function heldBy(run: Pick<AgentRun, 'leaseOwner'> | null | undefined): { leaseOwner?: string } {
  return run?.leaseOwner ? { leaseOwner: run.leaseOwner } : {};
}

export interface HeldLease {
  readonly owner: string;
  /** True once a renewal found the lease no longer this claim's. */
  readonly lost: boolean;
  /** Stop renewing and let the lease go. */
  release(): Promise<void>;
}

/**
 * Hold a claimed lease while a step runs: renew every `renewMs` until
 * released. A renewal that finds the lease gone marks it lost and stops;
 * the step's own writes are fenced, so it cannot write either way.
 */
export function holdLease(
  runs: Repository<AgentRun>,
  runId: string,
  owner: string,
  config: Pick<RunLeaseConfig, 'leaseMs' | 'renewMs'>,
  logger: Pick<Logger, 'warn'> = new Logger('RunLease'),
): HeldLease {
  let lost = false;
  let stopped = false;
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing.then(async () => {
      if (stopped || lost) return;
      try {
        if (!(await renewRunLease(runs, runId, owner, config.leaseMs))) {
          lost = true;
          clearInterval(timer);
          logger.warn(`Lost the lease on run ${runId}: another worker took it over; this step's writes will not land`);
        }
      } catch (err: any) {
        // A renewal that failed is retried at the next tick; the lease holds until it lapses.
        logger.warn(`Could not renew the lease on run ${runId}: ${err?.message ?? err}`);
      }
    });
  }, config.renewMs);
  timer.unref?.();
  return {
    owner,
    get lost() {
      return lost;
    },
    async release() {
      stopped = true;
      clearInterval(timer);
      await renewing;
      if (!lost) await releaseRunLease(runs, runId, owner);
    },
  };
}
