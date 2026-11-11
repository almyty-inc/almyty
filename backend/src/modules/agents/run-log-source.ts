import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { EntityManager, MoreThan, Repository } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { RunEventRecord, RunProjection, RunState, asStored, foldRunEvents } from './run-events';

/**
 * The log is the source of truth, durable runs step 5
 * (docs/design/durable-runs.md).
 *
 * A run's state is what its event log folds into (`foldRunEvents`). The
 * row's `steps`, `workingMemory` and the other fields the log describes are
 * a cache of that projection, kept by `writeRun`. Every reader that decides
 * something from a run's state (the step that resumes it, the run view, the
 * runs list a live view starts from, and `writeRun` itself under its row
 * lock) reads the row and then serves it with the projection's fields in
 * place of the row's (`serveRunFromLog`).
 *
 * When the two disagree the log wins. The difference is reported the way
 * the projection check reports one (a `run_projection_mismatch` warning and
 * metric, never the values), once for as long as it stands, and the next
 * write of the run repairs the row (writeRun writes the projection's value
 * of every field that differed along with its own change).
 *
 * A run with no events (created before the log, or nothing written since
 * its INSERT) is served from the row, as is a run whose log does not fold
 * (a gap, a repeat, a missing `run_started`): there is nothing better to
 * serve, and the fold error is reported.
 *
 * Reading the log costs only what was appended since the projection this
 * process last held for the run. Projections are kept per process, least
 * recently used out first, within RUN_LOG_CACHE_MB (default 64). A seq once
 * written never changes, so a kept projection is never stale, only behind;
 * the reader folds the events after it. A run this process has not seen
 * (another pod wrote it, or it was evicted) is read from its first event.
 *
 * RUN_LOG_SOURCE_OF_TRUTH switches it: `true`/`1`/`on`/`yes` on,
 * `false`/`0`/`off`/`no` off, and unset it is on except where NODE_ENV is
 * `production`. Off, every reader uses the row as before (the projection
 * check, RUN_PROJECTION_CHECK, still compares writes if it is on).
 */

/** Whether readers serve a run's state from its log: RUN_LOG_SOURCE_OF_TRUTH, on by default outside production. */
export function logIsSourceOfTruth(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.RUN_LOG_SOURCE_OF_TRUTH ?? '').trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(value)) return true;
  if (['false', '0', 'off', 'no'].includes(value)) return false;
  return String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'production';
}

/** The row's fields the log describes, in the order a difference is reported. */
export const RUN_STATE_FIELDS: ReadonlyArray<keyof RunState> = [
  'status',
  'currentStep',
  'totalCost',
  'totalTokens',
  'toolCallCount',
  'executionTime',
  'output',
  'error',
  'workingMemory',
  'metadata',
  'steps',
];

/** One differing field: hashes of both sides, and for steps where they part. Never the values. */
export interface FieldDifference {
  field: keyof RunState;
  rowHash: string;
  projectionHash: string;
  /** Steps only: how many each side holds and the first index they disagree at. */
  rowLength?: number;
  projectionLength?: number;
  firstDifferentIndex?: number;
}

export interface ProjectionMismatch {
  runId: string;
  organizationId: string | null;
  /** The run's head: the seq the projection was compared at. */
  seq: number;
  /** The head the fold started from. */
  fromSeq: number;
  /**
   * Where the fold started: the cached projection or the row as locked (the
   * projection check, after a write), or the log itself (a reader served
   * the run from its log, step 5).
   */
  from: 'cache' | 'row' | 'log';
  /** For `from: 'log'`: who read the run (the step, the run view, a write, ...). */
  reader?: string;
  differences: FieldDifference[];
  /** The fold itself refused the events (a gap, a repeat, a step out of order). */
  foldError?: string;
}

const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON equality that ignores key order, the way the json columns may hand keys back in another order. */
export function sameJson(a: any, b: any): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    for (const k of ak) if (!(k in b) || !sameJson(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Keys sorted, so equal values hash equal whatever order their keys are in. */
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const hashOf = (value: any): string => createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);

/** The row's value of a field, normalised the way storedRunState does it. */
export function rowField(row: Partial<AgentRun>, field: keyof RunState): any {
  switch (field) {
    case 'currentStep':
      return row.currentStep;
    case 'totalCost':
    case 'totalTokens':
    case 'toolCallCount':
    case 'executionTime':
      return row[field] ?? 0;
    case 'steps':
      return row.steps ?? [];
    default:
      return (row as any)[field] ?? null;
  }
}

export function describeDifference(field: keyof RunState, rowValue: any, projected: any): FieldDifference {
  const difference: FieldDifference = { field, rowHash: hashOf(rowValue), projectionHash: hashOf(projected) };
  if (field === 'steps' && Array.isArray(rowValue) && Array.isArray(projected)) {
    difference.rowLength = rowValue.length;
    difference.projectionLength = projected.length;
    const shorter = Math.min(rowValue.length, projected.length);
    let i = 0;
    while (i < shorter && sameJson(rowValue[i], asStored(projected[i]))) i++;
    difference.firstDifferentIndex = i;
  }
  return difference;
}

/**
 * Where a row and a projection differ, over `fields` (by default every
 * field the log describes). Same values with keys in another order are
 * not a difference.
 */
export function stateDifferences(
  row: Partial<AgentRun>,
  projection: RunState,
  fields: ReadonlyArray<keyof RunState> = RUN_STATE_FIELDS,
): FieldDifference[] {
  const out: FieldDifference[] = [];
  for (const field of fields) {
    const rowText = JSON.stringify(rowField(row, field) ?? null);
    const projectedText = JSON.stringify(projection[field] ?? null);
    if (rowText === projectedText) continue;
    const rowStored = JSON.parse(rowText);
    if (sameJson(rowStored, JSON.parse(projectedText))) continue;
    out.push(describeDifference(field, rowStored, projection[field]));
  }
  return out;
}

/** Default memory the kept projections may hold, per process. */
export const DEFAULT_RUN_LOG_CACHE_BYTES = 64 * 1024 * 1024;

/** Events read per query while folding a run's log. */
const LOG_PAGE = 1000;

interface Held {
  /** Whose log it is: the entity manager it was read through (one per database). */
  owner: object;
  projection: RunProjection;
  bytes: number;
}

/**
 * The projections this process holds, by run. A projection at seq N is the
 * fold of events 1..N, which never change, so it is reused for as long as it
 * is kept: a reader folds only the events after it.
 */
export class RunLogProjections {
  private readonly held = new Map<string, Held>();
  private bytes = 0;
  readonly stats = { reads: 0, eventsRead: 0, hits: 0 };

  constructor(private maxBytes = DEFAULT_RUN_LOG_CACHE_BYTES) {}

  setMaxBytes(maxBytes: number): void {
    this.maxBytes = maxBytes;
    this.trim();
  }

  forget(runId?: string): void {
    if (runId === undefined) {
      this.held.clear();
      this.bytes = 0;
      return;
    }
    const entry = this.held.get(runId);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.held.delete(runId);
  }

  /** The projection kept for a run at exactly `headSeq`, if any. */
  peek(owner: object, runId: string, headSeq: number): RunProjection | null {
    const entry = this.held.get(runId);
    return entry && entry.owner === owner && entry.projection.headSeq === headSeq ? entry.projection : null;
  }

  /**
   * The run's projection at `headSeq`: the kept one folded forward with the
   * events after it, read through `events`. Null when the run has no events
   * up to `headSeq`. Throws when the log does not fold or ends before
   * `headSeq`. The projection returned is shared: do not change it.
   */
  async at(owner: object, events: Repository<AgentRunEvent>, runId: string, headSeq: number): Promise<RunProjection | null> {
    this.stats.reads++;
    if (!headSeq || headSeq < 1) return null;
    const entry = this.held.get(runId);
    let start: RunProjection | null = entry && entry.owner === owner && entry.projection.headSeq <= headSeq ? entry.projection : null;
    if (start && start.headSeq === headSeq) {
      this.stats.hits++;
      this.touch(runId, entry!);
      return start;
    }
    let after = start?.headSeq ?? 0;
    for (;;) {
      const page = (await events.find({ where: { runId, seq: MoreThan(after) }, order: { seq: 'ASC' }, take: LOG_PAGE })) as RunEventRecord[];
      const wanted = page.filter((e) => e.seq <= headSeq);
      this.stats.eventsRead += wanted.length;
      if (wanted.length) {
        start = foldRunEvents(start, wanted);
        after = wanted[wanted.length - 1].seq;
      }
      if (after >= headSeq || page.length < LOG_PAGE || wanted.length < page.length) break;
    }
    if (!start) return null;
    if (start.headSeq !== headSeq) throw new Error(`run event log ends at seq ${start.headSeq}, the row is at ${headSeq}`);
    this.remember(owner, runId, start);
    return start;
  }

  /**
   * After a committed write: the projection kept at the head before it moves
   * on with the events the write appended. One kept at any other head is
   * left as it is; a reader folds forward from it.
   */
  advance(owner: object, runId: string, fromSeq: number, appended: RunEventRecord[]): void {
    const entry = this.held.get(runId);
    if (!entry || entry.owner !== owner || entry.projection.headSeq !== fromSeq || !appended.length) return;
    try {
      this.remember(owner, runId, foldRunEvents(entry.projection, appended)!);
    } catch {
      this.forget(runId);
    }
  }

  /** Keep `projection` as the run's (exposed for the writer, which knows the projection a write leaves). */
  remember(owner: object, runId: string, projection: RunProjection): void {
    this.forget(runId);
    const bytes = JSON.stringify(projection).length;
    if (bytes > this.maxBytes) return;
    this.held.set(runId, { owner, projection, bytes });
    this.bytes += bytes;
    this.trim();
  }

  private touch(runId: string, entry: Held): void {
    this.held.delete(runId);
    this.held.set(runId, entry);
  }

  private trim(): void {
    for (const [id, entry] of this.held) {
      if (this.bytes <= this.maxBytes) break;
      this.held.delete(id);
      this.bytes -= entry.bytes;
    }
  }
}

function cacheBytesFromEnv(): number {
  const mb = Number(process.env.RUN_LOG_CACHE_MB);
  return process.env.RUN_LOG_CACHE_MB !== undefined && Number.isFinite(mb) && mb >= 0 ? mb * 1024 * 1024 : DEFAULT_RUN_LOG_CACHE_BYTES;
}

/** This process's projections. */
export const runLogProjections = new RunLogProjections(cacheBytesFromEnv());

// ── Reporting a difference ──

export type LogMismatchListener = (mismatch: ProjectionMismatch) => void;

const mismatchListeners = new Set<LogMismatchListener>();
const logger = new Logger('RunLogSource');

/**
 * Be told of every difference a reader found between a run's row and its
 * log (the projection check service reports them as it reports its own).
 * Returns the function that stops listening. With no listener a difference
 * is still logged here, in the same shape.
 */
export function onLogMismatch(listener: LogMismatchListener): () => void {
  mismatchListeners.add(listener);
  return () => {
    mismatchListeners.delete(listener);
  };
}

/**
 * What each run was last reported for: the differing fields' hashes on both
 * sides (or the fold error). A run read again and again, or whose head only
 * moved by step progress, is reported once until the row or the log's state
 * changes; the next state write repairs the row, so there is nothing more.
 */
const reported = new Map<string, string>();
const REPORTED_MAX = 10_000;

function report(mismatch: ProjectionMismatch): void {
  const signature = JSON.stringify([mismatch.differences, mismatch.foldError ?? null]);
  if (reported.get(mismatch.runId) === signature) return;
  if (reported.size >= REPORTED_MAX) reported.clear();
  reported.set(mismatch.runId, signature);
  if (!mismatchListeners.size) {
    logger.warn({
      message: 'Run event log does not fold into the run row',
      event: 'run_projection_mismatch',
      runId: mismatch.runId,
      seq: mismatch.seq,
      fromSeq: mismatch.fromSeq,
      from: mismatch.from,
      reader: mismatch.reader,
      fields: mismatch.differences.map((d) => d.field),
      differences: mismatch.differences,
      ...(mismatch.foldError ? { foldError: mismatch.foldError } : {}),
    });
    return;
  }
  for (const listener of mismatchListeners) {
    try {
      listener(mismatch);
    } catch (err: any) {
      logger.warn(`A run log mismatch listener failed for run ${mismatch.runId}: ${err?.message ?? err}`);
    }
  }
}

/** Forget what was reported and every kept projection (specs). */
export function resetRunLogSource(): void {
  reported.clear();
  runLogProjections.forget();
}

// ── Serving a run from its log ──

export interface ServedRun<T extends Partial<AgentRun>> {
  /** The row with the projection's value of every field it holds, or the row itself when the log has nothing to say. */
  run: T;
  /** The projection the run was served from, or null (no events, the log does not fold, or switched off). */
  projection: RunProjection | null;
  /** The fields the row held differently from the log: what the next write repairs. */
  differences: FieldDifference[];
}

function managerOf(runs: Repository<AgentRun> | EntityManager): EntityManager | null {
  const manager = (runs as any)?.manager ?? ((runs as any)?.getRepository ? runs : null);
  return manager && typeof manager.getRepository === 'function' ? (manager as EntityManager) : null;
}

/**
 * A run as its log describes it. `row` is the run as read (any columns; a
 * field it does not hold is not added). `runs` is how the log is reached: a
 * repository or the entity manager of a transaction. `owner` names whose
 * log it is for the kept projections (the outer manager; a transaction's
 * own manager is a new object each time).
 *
 * The row comes back unchanged when the switch is off, it has no events
 * (`headSeq` 0 or unset), its log has none, or the log does not fold (the
 * fold error is reported). Otherwise a copy of the row comes back with the
 * projection's values (deep copies: the caller may change them); where they
 * differ from the row, that is reported and returned in `differences`.
 */
export async function serveRunFromLog<T extends Partial<AgentRun> & { id: string }>(
  runs: Repository<AgentRun> | EntityManager,
  row: T,
  reader: string,
  owner?: object,
): Promise<ServedRun<T>> {
  const unchanged: ServedRun<T> = { run: row, projection: null, differences: [] };
  if (!row || !logIsSourceOfTruth()) return unchanged;
  const headSeq = Number(row.headSeq ?? 0);
  if (!headSeq) return unchanged;
  const manager = managerOf(runs);
  if (!manager) return unchanged;
  const key = owner ?? manager;

  let projection: RunProjection | null;
  try {
    projection = await runLogProjections.at(key, manager.getRepository(AgentRunEvent), row.id, headSeq);
  } catch (err: any) {
    runLogProjections.forget(row.id);
    report({
      runId: row.id,
      organizationId: (row as any).organizationId ?? null,
      seq: headSeq,
      fromSeq: 0,
      from: 'log',
      reader,
      differences: [],
      foldError: String(err?.message ?? err),
    });
    return unchanged;
  }
  if (!projection) return unchanged;

  const fields = RUN_STATE_FIELDS.filter((field) => field in row);
  const differences = stateDifferences(row, projection, fields);
  if (differences.length) {
    report({
      runId: row.id,
      organizationId: (row as any).organizationId ?? null,
      seq: headSeq,
      fromSeq: 0,
      from: 'log',
      reader,
      differences,
    });
  }
  const served = Object.assign(Object.create(Object.getPrototypeOf(row)), row) as T;
  for (const field of fields) (served as any)[field] = asStored(projection[field]);
  return { run: served, projection, differences };
}

/** Each run of a list served from its log (serveRunFromLog), in order. */
export async function serveRunsFromLog<T extends Partial<AgentRun> & { id: string }>(
  runs: Repository<AgentRun>,
  rows: T[],
  reader: string,
): Promise<T[]> {
  if (!logIsSourceOfTruth() || !rows.length) return rows;
  const out: T[] = [];
  for (const row of rows) out.push((await serveRunFromLog(runs, row, reader)).run);
  return out;
}
