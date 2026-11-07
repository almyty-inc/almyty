import { Logger } from '@nestjs/common';
import { FindOptionsWhere, In, IsNull, Not, Repository } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { RunEventDraft, RunEventRecord, asStored, baselineOf, commitEvents, runStartedEvent } from './run-events';

/**
 * The columns of a run whose changes are logged (run-events.ts), plus
 * `deliveredAt`, the delivery receipt, which a `result_delivered` note
 * goes with, and the lease columns (LEASE_COLUMNS), which are not.
 */
export type RunChange = Partial<
  Pick<
    AgentRun,
    | 'status'
    | 'currentStep'
    | 'totalCost'
    | 'totalTokens'
    | 'toolCallCount'
    | 'executionTime'
    | 'output'
    | 'error'
    | 'workingMemory'
    | 'metadata'
    | 'steps'
    | 'deliveredAt'
    | 'nextWakeAt'
    | 'leaseOwner'
    | 'leaseExpiresAt'
    | 'attempt'
    | 'takeovers'
  >
>;

/**
 * Who holds a run and when it next needs a worker (durable runs step 3,
 * run-lease.ts). Not the run's state: a write of these alone appends no
 * event, and they are not in the projection.
 */
export const LEASE_COLUMNS = ['nextWakeAt', 'leaseOwner', 'leaseExpiresAt', 'attempt', 'takeovers'] as const;

export interface WriteRunOptions {
  /**
   * Lock and read only these columns (id and headSeq always). Only for a
   * change of lease columns alone, which needs nothing more of the row: a
   * lease renewal should not read a run's steps back every few seconds.
   */
  select?: Array<keyof AgentRun>;
  /**
   * Append the notes alone, as a step's progress (durable runs step 4,
   * run-resume.ts): what a step has done so far, written before its commit.
   * The change must be empty. Nothing of the row's state is read or
   * written but headSeq (and updatedAt: progress is progress, for the
   * reaper), and no `step_committed` closes the events, so a reader can
   * tell a step under way from one committed. Each note's step defaults to
   * the run's current step.
   */
  progress?: boolean;
}

const isLeaseOnly = (patch: RunChange): boolean =>
  Object.keys(patch).every((key) => (LEASE_COLUMNS as readonly string[]).includes(key));

/** What a progress write locks and reads: enough to guard it and to tell whether the run is done. */
const PROGRESS_READ = ['id', 'headSeq', 'status', 'currentStep', 'leaseOwner'];

/** Statuses a worker is wanted for straight away. */
const GOING: readonly string[] = [AgentRunStatus.PENDING, AgentRunStatus.RUNNING];

/**
 * When the run next needs a worker, from the status a write leaves it in,
 * unless the write says itself: a run going is due now, a sleep keeps the
 * wake time its step set, and a run waiting on a person or finished has
 * none. Every writer goes through here, so a run resumed by input or an
 * approval is due even if the nudge its writer queued is lost.
 */
function withWake(patch: RunChange): RunChange {
  if ('nextWakeAt' in patch || !('status' in patch) || patch.status === undefined) return patch;
  if (GOING.includes(patch.status)) return { ...patch, nextWakeAt: new Date() };
  if (patch.status === AgentRunStatus.SLEEPING) return patch;
  return { ...patch, nextWakeAt: null };
}

/**
 * Write a run's state and append the events describing the write, in one
 * transaction: the one way a run's state changes (durable runs step 1,
 * docs/design/durable-runs.md).
 *
 * The row is read under a row lock, with `where` (its id plus whatever the
 * caller's compare-and-set needs). No row: nothing is written and null
 * comes back, the way an UPDATE that matched nothing reports it. `change`
 * is the columns to set, or a function of the locked row that returns them
 * (for a merge, e.g. one metadata key, that must not write back a stale
 * copy of the rest), or null to write nothing.
 *
 * The events are what the change does to the row as locked, numbered from
 * its headSeq + 1, and the row's headSeq advances to the last of them.
 * Because every writer goes through here, the lock orders them and each
 * diff starts where the previous writer left the row: the log has no gap,
 * no repeat, and folds back into exactly what the row holds. The UPDATE
 * still names the headSeq it read and the primary key (runId, seq) refuses
 * a repeated seq, should anything write around the lock.
 *
 * A change of lease columns alone with no notes (a claim, a renewal, a
 * release: run-lease.ts) appends nothing and leaves headSeq and updatedAt
 * as they were: holding a run is not progress, and the reaper reads
 * updatedAt as progress. A write that sets the status also sets
 * `nextWakeAt` from it (withWake).
 *
 * Returns the row as written (the locked row with the change applied).
 */
export async function writeRun(
  runs: Repository<AgentRun>,
  where: FindOptionsWhere<AgentRun> & { id: any },
  change: RunChange | ((row: AgentRun) => RunChange | null),
  notes: RunEventDraft[] = [],
  options: WriteRunOptions = {},
): Promise<AgentRun | null> {
  const committed: RunWritten[] = [];
  if (options.progress && options.select) throw new Error('writeRun: a progress write reads its own columns');
  const select = options.progress
    ? Object.fromEntries(PROGRESS_READ.map((c) => [c, true]))
    : options.select
      ? Object.fromEntries([...new Set<string>(['id', 'headSeq', ...options.select])].map((c) => [c, true]))
      : undefined;
  const result = await runs.manager.transaction(async (tx) => {
    const repo = tx.getRepository(AgentRun);
    const row = await repo.findOne({ where, lock: { mode: 'pessimistic_write' }, ...(select ? { select: select as any } : {}) });
    if (!row) return null;
    const asked = typeof change === 'function' ? change(row) : change;
    if (!asked) return null;
    const head = row.headSeq ?? 0;
    if (options.progress) {
      if (Object.keys(asked).length > 0) throw new Error('writeRun: a progress write changes nothing but the log');
      if (notes.length === 0) return null;
      // Progress before the run's first commit opens its log, as that commit would have.
      const opening: RunEventDraft[] = [];
      if (head === 0) {
        const whole = await repo.findOne({ where: { id: row.id } });
        if (whole) opening.push(runStartedEvent(baselineOf(whole)));
      }
      const records = [...opening, ...notes].map((n, i) => ({
        runId: row.id,
        seq: head + i + 1,
        type: n.type,
        step: n.step ?? row.currentStep ?? 0,
        payload: asStored(n.payload ?? {}),
      }));
      const headSeq = head + records.length;
      const res = await repo.update({ id: row.id, headSeq: head }, { headSeq } as any);
      if ((res.affected ?? 0) === 0) return null;
      await tx.getRepository(AgentRunEvent).insert(records.map((r) => ({ ...r })));
      const next = Object.assign(Object.create(Object.getPrototypeOf(row)), row, { headSeq }) as AgentRun;
      committed.push({ before: row, after: next, events: records, progress: true });
      return next;
    }
    if (isLeaseOnly(asked) && notes.length === 0) {
      // A lease write appends nothing, so headSeq does not move and cannot
      // tell two of them apart: the UPDATE names the caller's where too.
      // And keeps updatedAt: TypeORM stamps it on every UPDATE unless the SET names it.
      const res = await repo.update({ ...where, id: row.id, headSeq: head } as any, { ...asked, updatedAt: () => '"updatedAt"' } as any);
      if ((res.affected ?? 0) === 0) return null;
      return Object.assign(Object.create(Object.getPrototypeOf(row)), row, asked) as AgentRun;
    }
    if (select) throw new Error('writeRun: a write that reads only some columns may change lease columns only');
    const patch = withWake(asked);
    const next = Object.assign(Object.create(Object.getPrototypeOf(row)), row, patch) as AgentRun;
    const events = commitEvents(baselineOf(row), next, next.steps, notes);
    const headSeq = head + events.length;
    const res = await repo.update({ id: row.id, headSeq: head }, { ...patch, headSeq } as any);
    if ((res.affected ?? 0) === 0) return null;
    const records = events.map((e, i) => ({ runId: row.id, seq: head + i + 1, type: e.type, step: e.step, payload: e.payload }));
    await tx.getRepository(AgentRunEvent).insert(records.map((r) => ({ ...r })));
    next.headSeq = headSeq;
    committed.push({ before: row, after: next, events: records });
    return next;
  });
  // Committed: tell whoever watches run writes (the projection check, the
  // live run views). Nothing they do can fail or slow down the write.
  for (const written of committed) notifyRunWritten(written);
  return result;
}

/**
 * One committed run write: the row as it was locked, the row as written,
 * and the events appended, in seq order.
 */
export interface RunWritten {
  before: AgentRun;
  after: AgentRun;
  events: Array<RunEventRecord & { runId: string }>;
  /**
   * A step's progress (WriteRunOptions.progress): markers only, the row's
   * state untouched, and `before` / `after` hold only the columns it read.
   */
  progress?: boolean;
}

export type RunWriteListener = (written: RunWritten) => void | Promise<void>;

const runWriteListeners = new Set<RunWriteListener>();

/**
 * Watch every committed run write (durable runs step 2): the projection
 * check folds the appended events and compares them with the row, and the
 * live run views are told the log moved. Called after the transaction
 * commits, never inside it; a listener that throws or rejects is logged
 * and ignored. Returns the function that stops watching.
 *
 * `writeRun` is a plain function its many callers hand a repository, so
 * the services that watch it register here rather than being injected
 * into every caller.
 */
export function onRunWritten(listener: RunWriteListener): () => void {
  runWriteListeners.add(listener);
  return () => {
    runWriteListeners.delete(listener);
  };
}

const listenerLogger = new Logger('RunWriteListeners');

function notifyRunWritten(written: RunWritten): void {
  for (const listener of runWriteListeners) {
    try {
      const out = listener(written);
      if (out && typeof (out as Promise<void>).catch === 'function') {
        (out as Promise<void>).catch((err) => listenerLogger.warn(`A run write listener failed for run ${written.after.id}: ${err?.message ?? err}`));
      }
    } catch (err: any) {
      listenerLogger.warn(`A run write listener failed for run ${written.after.id}: ${err?.message ?? err}`);
    }
  }
}

/** A change that sets some metadata keys on the row as it stands, leaving the rest. */
export function mergeMetadata(keys: Record<string, any>): (row: AgentRun) => RunChange {
  return (row) => ({ metadata: { ...(row.metadata ?? {}), ...keys } });
}

/** A `where` value for a run that has not finished (the list `AgentRun.isDone()` answers with). */
export function notDone() {
  return Not(In([AgentRunStatus.COMPLETED, AgentRunStatus.FAILED, AgentRunStatus.CANCELLED, AgentRunStatus.TIMEOUT]));
}

/**
 * Claim a finished run's result for handing on (a schedule's channel or
 * webhook, the always-on thread's owner): `deliveredAt` is set once, so a
 * step processed twice cannot post twice. The claim is on the run's log.
 * True when this caller won it.
 */
export async function claimDelivery(runs: Repository<AgentRun>, runId: string, via: 'schedule' | 'always_on'): Promise<boolean> {
  const claimed = await writeRun(runs, { id: runId, deliveredAt: IsNull() }, { deliveredAt: new Date() }, [
    { type: 'delivery_claimed', step: null, payload: { via } },
  ]);
  return !!claimed;
}

/**
 * Every logged column as an in-memory run holds it: the change for a
 * writer that worked on a loaded run object and used to `save` it whole.
 */
export function runStateOf(run: AgentRun): RunChange {
  return {
    status: run.status,
    currentStep: run.currentStep,
    totalCost: run.totalCost,
    totalTokens: run.totalTokens,
    toolCallCount: run.toolCallCount,
    executionTime: run.executionTime,
    output: run.output,
    error: run.error,
    workingMemory: run.workingMemory,
    metadata: run.metadata,
    steps: run.steps,
    // A sleep's wake time goes with it; any other status sets its own (withWake).
    ...(run.status === AgentRunStatus.SLEEPING && run.nextWakeAt ? { nextWakeAt: run.nextWakeAt } : {}),
  };
}