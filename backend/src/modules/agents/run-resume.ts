import { LessThanOrEqual, Repository } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { notDone, writeRun } from './run-event-writer';
import { RunEventDraft, RunEventRecord, STEP_PROGRESS_TYPES } from './run-events';
import { heldBy } from './run-lease';
import type { WriteAttempt } from './unknown-writes';

/**
 * Resume and idempotency keys, durable runs step 4
 * (docs/design/durable-runs.md).
 *
 * A step writes its progress on the run's log as it goes, before its
 * commit: `model_answered` once the model has answered, `tool_started`
 * before each call and `tool_finished` once the call's outcome is known.
 * A worker that picks the step up again (a takeover after a lapsed lease,
 * or a retried job) reads that progress first and resumes from it: the
 * model is not asked again and a finished call is not made again; its
 * recorded outcome stands in for it. The step's commit then describes the
 * step exactly as an uninterrupted one would have.
 *
 * Every call carries an idempotency key, (runId, step, callIndex): the
 * same call on every attempt of the step gets the same key. It is on the
 * log with the call, checked there before any call, and sent to tools that
 * accept one (ToolExecutionOptions.idempotencyKey), so a call whose outcome
 * the log does not know (started, not finished: the worker died in the
 * call) reaches such a tool again with the key it was first made with. A
 * write to a tool that takes no key is not made again silently: it is
 * tried again with care, each try on the log (`tool_attempted`), and a
 * person decides (unknown-writes.ts).
 *
 * A step's progress is the tail of the log written at its step number:
 * every event of step N comes after the commit that moved the run to N
 * (whose events carry step N - 1), and a step number is never processed
 * again once its commit lands, so the tail is read from the end, newest
 * first, until an event of another step.
 */

/** The idempotency key of a step's call: the same on every attempt of the step. */
export function idempotencyKey(runId: string, step: number, callIndex: number): string {
  return `${runId}:${step}:${callIndex}`;
}

/** The model's answer, as `model_answered` carries it. */
export interface ModelAnswered {
  /** The ChatResponse, as stored. */
  response: Record<string, any>;
  /** How many messages the call was made with (the step's record says so). */
  messageCount: number;
  /** The role that made the call. */
  role?: string;
  /** What compaction did before the call this step, when it folded anything. */
  compaction?: {
    contextSummary: any;
    cost: number;
    tokens: number;
    folded: number;
    foldedTotal: number;
  };
}

/** A call's outcome, as `tool_finished` carries it: enough to stand in for the call. */
export interface CallFinished {
  callIndex: number;
  key: string;
  tool: string;
  /** What the step reads of the call afterwards (result with personal data hidden). */
  call: { result?: any; error?: string; executionTime?: number; cached?: boolean };
  /** Steps the call recorded, as they are stored (capped, personal data hidden). */
  steps: any[];
  /** What the call added to the run's totals. */
  cost: number;
  tokens: number;
  toolCalls: number;
  /** Set when the call changed them: the value it left. */
  workingMemory?: any;
  metadata?: any;
  /** What the call left for the rest of the step (held calls, waking calls, ...), by name. */
  local: Record<string, any>;
}

const PAGE = 100;

/** The progress of one step of one run, read from its log, and the writer of more. */
export class StepJournal {
  private readonly answered: ModelAnswered | null;
  private readonly started = new Set<number>();
  private readonly finished = new Map<number, CallFinished>();
  private readonly attempts = new Map<number, Map<number, WriteAttempt>>();

  private constructor(
    private readonly runs: Repository<AgentRun>,
    private readonly run: Pick<AgentRun, 'id' | 'leaseOwner'>,
    readonly step: number,
    events: RunEventRecord[],
  ) {
    let answered: ModelAnswered | null = null;
    for (const event of events) {
      const p = event.payload ?? {};
      if (event.type === 'model_answered') answered = p as ModelAnswered;
      if (event.type === 'tool_started') this.started.add(Number(p.callIndex));
      if (event.type === 'tool_finished') this.finished.set(Number(p.callIndex), p as CallFinished);
      if (event.type === 'tool_attempted') {
        const { callIndex, key: _key, tool: _tool, result: _result, phase, ...attempt } = p;
        if (phase === 'started') this.noteAttempt(Number(callIndex), { attempt: Number(p.attempt), outcome: 'unknown', cutOff: true }, false);
        else this.noteAttempt(Number(callIndex), attempt as WriteAttempt, true);
      }
    }
    this.answered = answered;
  }

  /**
   * Read the progress of the step the run is at: the events of that step
   * after the commit that moved the run there, newest first from the head
   * until an event of another step. One indexed read in the common case
   * (the previous step's commit is in the first page).
   */
  static async read(runs: Repository<AgentRun>, run: Pick<AgentRun, 'id' | 'leaseOwner' | 'currentStep' | 'headSeq'>): Promise<StepJournal> {
    const step = run.currentStep ?? 0;
    const events = runs.manager.getRepository(AgentRunEvent);
    const tail: RunEventRecord[] = [];
    let cursor = run.headSeq ?? 0;
    // The row loaded for the step may be behind a progress write made after it was read; read from the true end.
    let reading = true;
    let first = true;
    while (reading) {
      const page = await events.find({
        where: first ? { runId: run.id } : { runId: run.id, seq: LessThanOrEqual(cursor) },
        order: { seq: 'DESC' },
        take: PAGE,
      });
      first = false;
      for (const event of page) {
        if ((event.step ?? null) !== step) {
          reading = false;
          break;
        }
        tail.push(event);
        cursor = event.seq - 1;
      }
      if (page.length < PAGE || cursor < 1) reading = false;
    }
    tail.reverse();
    return new StepJournal(runs, run, step, tail.filter((e) => STEP_PROGRESS_TYPES.includes(e.type as any)));
  }

  /** A journal with nothing on it, for a step that is not resumable. */
  static empty(runs: Repository<AgentRun>, run: Pick<AgentRun, 'id' | 'leaseOwner' | 'currentStep'>): StepJournal {
    return new StepJournal(runs, run, run.currentStep ?? 0, []);
  }

  /** Whether an earlier attempt of this step left anything to resume from. */
  get resuming(): boolean {
    return !!this.answered || this.started.size > 0;
  }

  /** The model's answer an earlier attempt of this step got, if any. */
  get answer(): ModelAnswered | null {
    return this.answered;
  }

  /** The outcome of call `callIndex` an earlier attempt made, if it is known. */
  outcomeOf(callIndex: number): CallFinished | null {
    return this.finished.get(callIndex) ?? null;
  }

  /** Whether an earlier attempt started call `callIndex` (made it, or died in it). */
  wasStarted(callIndex: number): boolean {
    return this.started.has(callIndex) || this.finished.has(callIndex);
  }

  key(callIndex: number): string {
    return idempotencyKey(this.run.id, this.step, callIndex);
  }

  /** Record the model's answer. False when the step may not go on (lease lost, run finished or moved on). */
  recordAnswer(answer: ModelAnswered): Promise<boolean> {
    return this.write({ type: 'model_answered', step: this.step, payload: answer });
  }

  /**
   * Record that call `callIndex` is about to be made, with its key and the
   * arguments it is made with (the real ones: a resumed step reads them;
   * whoever views the log sees them with personal data hidden,
   * run-log-privacy.ts). Before the call, always.
   */
  recordStarted(callIndex: number, tool: string, parameters?: Record<string, any>): Promise<boolean> {
    this.started.add(callIndex);
    return this.write({
      type: 'tool_started',
      step: this.step,
      payload: { callIndex, key: this.key(callIndex), tool, ...(parameters !== undefined ? { parameters } : {}) },
    });
  }

  /**
   * The attempts made again at call `callIndex`, its first outcome lost
   * (unknown-writes.ts), by number. One begun and never come back (yet
   * another death) is `unknown` and `cutOff`.
   */
  attemptsOf(callIndex: number): WriteAttempt[] {
    return [...(this.attempts.get(callIndex)?.values() ?? [])].sort((a, b) => a.attempt - b.attempt);
  }

  /** Record that attempt `n` at call `callIndex` is about to be made (`tool_attempted`, phase `started`). */
  recordAttemptStarted(callIndex: number, tool: string, n: number): Promise<boolean> {
    this.noteAttempt(callIndex, { attempt: n, outcome: 'unknown', cutOff: true }, false);
    return this.write({ type: 'tool_attempted', step: this.step, payload: { callIndex, key: this.key(callIndex), tool, phase: 'started', attempt: n } });
  }

  /** Record what attempt `attempt.attempt` at call `callIndex` came to (phase `finished`, with its result as stored). */
  recordAttempt(callIndex: number, tool: string, attempt: WriteAttempt, result?: { result?: any }): Promise<boolean> {
    this.noteAttempt(callIndex, attempt, true);
    return this.write({ type: 'tool_attempted', step: this.step, payload: { callIndex, key: this.key(callIndex), tool, phase: 'finished', ...attempt, ...(result ?? {}) } });
  }

  private noteAttempt(callIndex: number, attempt: WriteAttempt, finished: boolean): void {
    const byNumber = this.attempts.get(callIndex) ?? new Map<number, WriteAttempt>();
    if (finished || !byNumber.has(attempt.attempt)) byNumber.set(attempt.attempt, attempt);
    this.attempts.set(callIndex, byNumber);
  }

  /** Record what call `callIndex` came to. */
  recordFinished(outcome: Omit<CallFinished, 'key'>): Promise<boolean> {
    const finished: CallFinished = { ...outcome, key: this.key(outcome.callIndex) };
    this.finished.set(outcome.callIndex, finished);
    return this.write({ type: 'tool_finished', step: this.step, payload: finished });
  }

  /**
   * One progress write, guarded like the step's commit: the run still at
   * this step, not finished, and held by this worker's lease.
   */
  private async write(note: RunEventDraft): Promise<boolean> {
    const written = await writeRun(
      this.runs,
      { id: this.run.id, currentStep: this.step, status: notDone(), ...heldBy(this.run) },
      {},
      [note],
      { progress: true },
    );
    return !!written;
  }
}
