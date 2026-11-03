import { createHash } from 'crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import { MetricsRecorderService } from '../../common/metrics/metrics-recorder.service';
import { MetricStatus, MetricType } from '../../entities/usage-metric.entity';
import { RunWritten, onRunWritten } from './run-event-writer';
import { RunProjection, RunState, asStored, foldRunEvents, storedRunState } from './run-events';

/**
 * The projection check, durable runs step 2 ("shadow read",
 * docs/design/durable-runs.md).
 *
 * After every committed run write, the events it appended are folded onto
 * the run's projection and the result is compared with the row as
 * written. A difference means the log no longer describes the row: it is
 * logged (run id, seq and which fields differ, as hashes, never their
 * content) and counted in usage_metrics as `run_projection_mismatch`.
 * The write has already committed and is never failed or slowed by it.
 *
 * The fold is incremental. The projection each check ends with is kept
 * (bounded by bytes, least recently used out first), so the next write of
 * that run folds only what it appended. A run not in the cache (first
 * write seen by this process, another pod wrote it last, evicted) starts
 * from the row as the write locked it, which is the projection at the
 * previous head when the log is sound. Nothing reads the log back from
 * the database: a 10,000-event run costs the same as a 10-event one, the
 * size of its state rather than the length of its history.
 *
 * A cached projection catches what the locked row cannot: a write around
 * `writeRun` changes the row without the log, and the next write's
 * projection, folded from the cache, no longer matches.
 */

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
  /** The run's head after the write: the seq the projection was compared at. */
  seq: number;
  /** The head the fold started from. */
  fromSeq: number;
  /** Where the fold started: the cached projection, or the row as locked. */
  from: 'cache' | 'row';
  differences: FieldDifference[];
  /** The fold itself refused the events (a gap, a repeat, a step out of order). */
  foldError?: string;
}

export interface ProjectionCheckStats {
  checks: number;
  mismatches: number;
  cacheHits: number;
  cacheMisses: number;
  cachedRuns: number;
  cachedBytes: number;
}

/** Default memory the cached projections may hold, per process. */
export const DEFAULT_PROJECTION_CACHE_BYTES = 32 * 1024 * 1024;

const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON equality that ignores key order, the way the json columns may hand keys back in another order. */
function sameJson(a: any, b: any): boolean {
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

/**
 * The check itself, without Nest: what the service runs on every write,
 * and what the specs drive directly.
 */
export class RunProjectionChecker {
  private readonly cache = new Map<string, { projection: RunProjection; bytes: number }>();
  private cachedBytes = 0;
  readonly stats = { checks: 0, mismatches: 0, cacheHits: 0, cacheMisses: 0 };

  constructor(
    private readonly onMismatch: (mismatch: ProjectionMismatch) => void,
    private readonly maxCacheBytes = DEFAULT_PROJECTION_CACHE_BYTES,
  ) {}

  snapshot(): ProjectionCheckStats {
    return { ...this.stats, cachedRuns: this.cache.size, cachedBytes: this.cachedBytes };
  }

  forget(runId?: string): void {
    if (runId === undefined) {
      this.cache.clear();
      this.cachedBytes = 0;
      return;
    }
    const held = this.cache.get(runId);
    if (!held) return;
    this.cachedBytes -= held.bytes;
    this.cache.delete(runId);
  }

  /** Compare one committed write. Returns the mismatch it reported, or null. */
  check(written: RunWritten): ProjectionMismatch | null {
    const { before, after, events } = written;
    if (!events.length) return null;
    this.stats.checks++;
    const runId = after.id;
    const fromSeq = before.headSeq ?? 0;
    const headSeq = after.headSeq ?? fromSeq + events.length;

    const held = this.cache.get(runId);
    let start: RunProjection | null;
    let from: 'cache' | 'row';
    if (held && held.projection.headSeq === fromSeq) {
      this.stats.cacheHits++;
      start = held.projection;
      from = 'cache';
    } else {
      this.stats.cacheMisses++;
      start = fromSeq === 0 ? null : { ...storedRunState(before), headSeq: fromSeq };
      from = 'row';
    }

    let projection: RunProjection | null = null;
    let foldError: string | undefined;
    try {
      projection = foldRunEvents(start, events);
    } catch (err: any) {
      foldError = String(err?.message ?? err);
    }

    const differences: FieldDifference[] = [];
    let bytes = 0;
    if (projection) {
      for (const field of RUN_STATE_FIELDS) {
        const rowValue = rowField(after, field);
        const projected = projection[field];
        const rowText = JSON.stringify(rowValue ?? null);
        const projectedText = JSON.stringify(projected ?? null);
        bytes += projectedText.length;
        if (rowText === projectedText) continue;
        // Same values, keys in another order: not a difference.
        const rowStored = JSON.parse(rowText);
        if (sameJson(rowStored, JSON.parse(projectedText))) continue;
        differences.push(describe(field, rowStored, projected));
      }
    }

    this.forget(runId);
    const mismatch: ProjectionMismatch | null =
      foldError || differences.length
        ? { runId, organizationId: after.organizationId ?? null, seq: headSeq, fromSeq, from, differences, ...(foldError ? { foldError } : {}) }
        : null;

    // Keep what the next write of this run starts from. After a mismatch
    // that is the row, so one difference is reported once, not on every
    // write after it.
    const keep: RunProjection = mismatch || !projection ? { ...storedRunState(after), headSeq } : projection;
    if (!after.isDone?.()) this.remember(runId, keep, mismatch || !projection ? JSON.stringify(keep).length : bytes);

    if (mismatch) {
      this.stats.mismatches++;
      this.onMismatch(mismatch);
    }
    return mismatch;
  }

  private remember(runId: string, projection: RunProjection, bytes: number): void {
    if (bytes > this.maxCacheBytes) return;
    this.cache.set(runId, { projection, bytes });
    this.cachedBytes += bytes;
    for (const [id, entry] of this.cache) {
      if (this.cachedBytes <= this.maxCacheBytes) break;
      this.cache.delete(id);
      this.cachedBytes -= entry.bytes;
    }
  }
}

/** The row's value of a field, normalised the way storedRunState does it. */
function rowField(row: RunWritten['after'], field: keyof RunState): any {
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

function describe(field: keyof RunState, rowValue: any, projected: any): FieldDifference {
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

/** Whether the projection check runs: RUN_PROJECTION_CHECK (true/1/on). Off when unset. */
export function projectionCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['true', '1', 'on', 'yes'].includes(String(env.RUN_PROJECTION_CHECK ?? '').trim().toLowerCase());
}

/**
 * Runs the check on every committed run write when RUN_PROJECTION_CHECK is
 * set (the staging and development deployments set it; production leaves
 * it off). A difference is a warning and a `run_projection_mismatch`
 * metric; the write it describes has already committed.
 */
@Injectable()
export class RunProjectionCheckService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunProjectionCheckService.name);
  readonly enabled = projectionCheckEnabled();
  readonly checker: RunProjectionChecker;
  private stop?: () => void;

  constructor(@Optional() private readonly metrics?: MetricsRecorderService) {
    const mb = Number(process.env.RUN_PROJECTION_CHECK_CACHE_MB);
    this.checker = new RunProjectionChecker(
      (mismatch) => this.report(mismatch),
      Number.isFinite(mb) && mb >= 0 ? mb * 1024 * 1024 : DEFAULT_PROJECTION_CACHE_BYTES,
    );
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.stop = onRunWritten((written) => {
      this.checker.check(written);
    });
    this.logger.log('Run projection check is on: every run write is compared with its event log');
  }

  onModuleDestroy(): void {
    this.stop?.();
    this.stop = undefined;
    this.checker.forget();
  }

  private report(mismatch: ProjectionMismatch): void {
    this.logger.warn({
      message: 'Run event log does not fold into the run row',
      event: 'run_projection_mismatch',
      runId: mismatch.runId,
      seq: mismatch.seq,
      fromSeq: mismatch.fromSeq,
      from: mismatch.from,
      fields: mismatch.differences.map((d) => d.field),
      differences: mismatch.differences,
      ...(mismatch.foldError ? { foldError: mismatch.foldError } : {}),
    });
    this.metrics?.record(MetricType.RUN_PROJECTION_MISMATCH, {
      status: MetricStatus.ERROR,
      organizationId: mismatch.organizationId,
      dimensions: {
        runId: mismatch.runId,
        seq: mismatch.seq,
        fields: mismatch.differences.map((d) => d.field),
        ...(mismatch.foldError ? { foldError: true } : {}),
      },
    });
  }
}
