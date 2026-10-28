import { Logger } from '@nestjs/common';
import { FindOptionsWhere, In, IsNull, Not, Repository } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { RunEventDraft, RunEventRecord, baselineOf, commitEvents } from './run-events';

/**
 * The columns of a run whose changes are logged (run-events.ts), plus
 * `deliveredAt`, the delivery receipt, which a `result_delivered` note
 * goes with.
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
  >
>;

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
 * Returns the row as written (the locked row with the change applied).
 */
export async function writeRun(
  runs: Repository<AgentRun>,
  where: FindOptionsWhere<AgentRun> & { id: any },
  change: RunChange | ((row: AgentRun) => RunChange | null),
  notes: RunEventDraft[] = [],
): Promise<AgentRun | null> {
  const committed: RunWritten[] = [];
  const result = await runs.manager.transaction(async (tx) => {
    const repo = tx.getRepository(AgentRun);
    const row = await repo.findOne({ where, lock: { mode: 'pessimistic_write' } });
    if (!row) return null;
    const patch = typeof change === 'function' ? change(row) : change;
    if (!patch) return null;
    const next = Object.assign(Object.create(Object.getPrototypeOf(row)), row, patch) as AgentRun;
    const head = row.headSeq ?? 0;
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
  };
}