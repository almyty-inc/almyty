import { isSideEffect, toolClass, type ClassifiableTool, type SideEffect } from '../tools/tool-side-effect';
import { takesIdempotencyKey } from '../tools/operation-header-params';
import type { ToolExecutionResult } from '../tools/tool-execution.types';
import { WORKSPACE_BUSY, WORKSPACE_WAKING } from '../runner/hosted-dispatch';

/**
 * A write whose outcome nobody knows (durable runs step 4,
 * docs/design/durable-runs.md, "Unknown outcomes").
 *
 * A step that resumes finds a call on its log as started and not finished:
 * the worker died while the call was out, or before its outcome landed. A
 * call that takes an idempotency key is simply made again with its key, and
 * the service it reaches makes it once. A read is made again too: reading
 * twice changes nothing. What is left is a write or a delete to a tool that
 * takes no key, where making it again may do the same thing twice. That one
 * is never made again silently:
 *
 *   1. It is tried again, up to `RUN_UNKNOWN_WRITE_RETRIES` times (3), the
 *      first after `RUN_UNKNOWN_WRITE_BACKOFF_MS` (1000) and each next one
 *      after twice as long, stopping at the first attempt with a definite
 *      outcome. Each attempt goes on the run's log (`tool_attempted`).
 *   2. The model is told plainly that an earlier attempt may already have
 *      happened, and how many attempts were made with what results.
 *   3. The run waits for a person (an approval of kind `unknown_outcome`)
 *      showing the call, its arguments with personal data hidden, and the
 *      attempts. Approved, the run carries on; rejected (or left to
 *      expire), the model is told to carry on without the action.
 */

/** Read from the environment each time, with defaults. */
export interface UnknownWriteSettings {
  /** How many times the call is tried again (0: not at all; the person still decides). */
  retries: number;
  /** The wait before the first try; each next one waits twice as long. */
  backoffMs: number;
}

const MAX_RETRIES = 10;

const wholeAtLeastZero = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export function unknownWriteSettings(env: NodeJS.ProcessEnv = process.env): UnknownWriteSettings {
  return {
    retries: Math.min(MAX_RETRIES, wholeAtLeastZero(env.RUN_UNKNOWN_WRITE_RETRIES, 3)),
    backoffMs: wholeAtLeastZero(env.RUN_UNKNOWN_WRITE_BACKOFF_MS, 1000),
  };
}

/** The wait before attempt `n` (1-based): the backoff, doubled for each attempt before it. */
export function backoffBefore(n: number, settings: UnknownWriteSettings): number {
  return settings.backoffMs * 2 ** Math.max(0, n - 1);
}

type CarefulTool = ClassifiableTool & {
  httpConfig?: { method?: string | null; headers?: Record<string, any> | null } | null;
  operation?: (ClassifiableTool['operation'] & { parameters?: { header?: Record<string, any> } | null }) | null;
};

/** What a tool's call does to data: the class stored on the tool, else the one its definition gives. */
export function sideEffectOf(tool: CarefulTool): SideEffect {
  return isSideEffect(tool.sideEffect) ? tool.sideEffect : toolClass(tool).sideEffect;
}

/**
 * Whether a call to this tool, its outcome unknown, must not simply be made
 * again: it writes or deletes, and takes no idempotency key.
 */
export function needsCareOnResume(tool: CarefulTool): boolean {
  return sideEffectOf(tool) !== 'read' && !takesIdempotencyKey(tool);
}

/**
 * What one attempt came to.
 *
 *   succeeded  the tool answered with success
 *   failed     the service answered and refused (a 4xx other than 408 and 429)
 *   not_run    the call was stopped before it reached the service (no such
 *              tool, no access, held by an approval rule)
 *   unknown    nothing definite: a timeout, a network error, a 5xx, 408 or
 *              429, a machine still starting, an exception
 */
export type AttemptOutcome = 'succeeded' | 'failed' | 'not_run' | 'unknown';

export interface WriteAttempt {
  /** 1-based, counted over every attempt of this call since the cut-off one. */
  attempt: number;
  outcome: AttemptOutcome;
  httpStatus?: number;
  /** The error, capped and with personal data hidden. */
  error?: string;
  executionTime?: number;
  /** Begun and never come back: another worker died during it (outcome `unknown`). */
  cutOff?: boolean;
}

export function isDefinite(outcome: AttemptOutcome): boolean {
  return outcome !== 'unknown';
}

export function attemptOutcomeOf(result: ToolExecutionResult | null | undefined): AttemptOutcome {
  if (!result) return 'unknown';
  if (result.success) return 'succeeded';
  if (result.approvalRequired || result.notFound || result.noAccess) return 'not_run';
  const code = result.metadata?.runnerErrorCode;
  if (code === WORKSPACE_WAKING || code === WORKSPACE_BUSY) return 'unknown';
  const status = Number(result.metadata?.httpStatus);
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'failed';
  return 'unknown';
}

const ERROR_CAP = 300;

/** The attempt as it is recorded, from what the executor returned (or threw). */
export function attemptOf(n: number, result: ToolExecutionResult | null, thrown?: unknown): WriteAttempt {
  const status = Number(result?.metadata?.httpStatus);
  const error = thrown ? String((thrown as any)?.message ?? thrown) : result && !result.success ? result.error : undefined;
  return {
    attempt: n,
    outcome: thrown ? 'unknown' : attemptOutcomeOf(result),
    ...(Number.isFinite(status) && status > 0 ? { httpStatus: status } : {}),
    ...(error ? { error: error.length > ERROR_CAP ? `${error.slice(0, ERROR_CAP)}...` : error } : {}),
    ...(result?.executionTime !== undefined ? { executionTime: result.executionTime } : {}),
  };
}

/**
 * Try the call again, after the attempts already made (`before`, from the
 * log: a worker that died during an earlier round), until one has a
 * definite outcome or the retries are spent. `begin` puts each attempt on
 * the log before it is made, and `record` once it has come back, so an
 * attempt cut off by yet another death is still counted (as `cutOff`); a
 * false from either (the run finished, or the lease was lost) stops here.
 */
export async function reattempt(opts: {
  settings: UnknownWriteSettings;
  before: WriteAttempt[];
  call: () => Promise<ToolExecutionResult>;
  begin: (n: number) => Promise<boolean>;
  record: (attempt: WriteAttempt, result: ToolExecutionResult | null) => Promise<boolean>;
  pause: (ms: number) => Promise<void>;
}): Promise<{ attempts: WriteAttempt[]; last: ToolExecutionResult | null; refused: boolean }> {
  const attempts = [...opts.before];
  let last: ToolExecutionResult | null = null;
  if (attempts.some((a) => isDefinite(a.outcome))) return { attempts, last, refused: false };
  for (let n = attempts.length + 1; n <= opts.settings.retries; n++) {
    await opts.pause(backoffBefore(n, opts.settings));
    if (!(await opts.begin(n))) return { attempts, last, refused: true };
    let result: ToolExecutionResult | null = null;
    let thrown: unknown;
    try {
      result = await opts.call();
    } catch (err) {
      thrown = err ?? new Error('the call failed');
    }
    const attempt = attemptOf(n, result, thrown);
    if (!(await opts.record(attempt, result))) return { attempts, last: result, refused: true };
    attempts.push(attempt);
    last = result;
    if (isDefinite(attempt.outcome)) break;
  }
  return { attempts, last, refused: false };
}

/** One attempt in words: "attempt 2 failed (HTTP 409: already exists)". */
export function attemptInWords(a: WriteAttempt): string {
  if (a.cutOff) return `attempt ${a.attempt} was cut off too, with no answer`;
  const detail = [a.httpStatus ? `HTTP ${a.httpStatus}` : '', a.error ?? ''].filter(Boolean).join(': ');
  const what =
    a.outcome === 'succeeded'
      ? 'succeeded'
      : a.outcome === 'failed'
        ? 'failed'
        : a.outcome === 'not_run'
          ? 'did not run'
          : 'got no clear answer';
  return `attempt ${a.attempt} ${what}${detail && a.outcome !== 'succeeded' ? ` (${detail})` : ''}`;
}

function attemptsInWords(attempts: WriteAttempt[]): string {
  if (!attempts.length) return 'It was not tried again.';
  const times = attempts.length === 1 ? 'once' : `${attempts.length} times`;
  return `It was tried again ${times}: ${attempts.map(attemptInWords).join('; ')}.`;
}

/**
 * What the model reads as the call's result: that an earlier attempt may
 * already have happened, and every attempt since with its result.
 */
export function tellModel(tool: string, attempts: WriteAttempt[], last: ToolExecutionResult | null): string {
  const lines = [
    `Careful: an earlier attempt at this ${tool} call may already have gone through. The step was cut off while the call was out, and nobody knows whether it reached the service. ${tool} takes no idempotency key, so making it again may do the same thing twice.`,
    attemptsInWords(attempts),
  ];
  const final = attempts[attempts.length - 1];
  if (final?.outcome === 'succeeded' && last) {
    lines.push(`What the last attempt returned: ${typeof last.data === 'string' ? last.data : JSON.stringify(last.data ?? null)}`);
  }
  lines.push('A person has been asked to check this before the run goes on. Do not make this call again yourself.');
  return lines.join('\n');
}

/** Why the run waits, for the person deciding. */
export function approvalReason(tool: string, attempts: WriteAttempt[]): string {
  return [
    `A call to “${tool}” was cut off when the worker running it stopped, so it may already have happened. This tool takes no idempotency key, so doing it again could do it twice.`,
    attemptsInWords(attempts),
    'Approve to let the agent carry on, reject to have it carry on without this action.',
  ].join(' ');
}

/** The person's decision, added to what the model reads as the call's result. */
export function decisionForModel(status: 'approved' | 'rejected' | 'expired', decidedBy: string | null, note: string | null): string {
  const by = decidedBy ? ` (${decidedBy})` : '';
  const said = note ? ` Their note: ${note}` : '';
  if (status === 'approved') return `A person${by} checked this and approved carrying on.${said}`;
  if (status === 'rejected') {
    return `A person${by} checked this and rejected it. Treat this action as not done, do not make this call again, and carry on without it.${said}`;
  }
  return 'Nobody checked this in time. Treat this action as not done, do not make this call again, and carry on without it.';
}

/**
 * A call of this kind waiting for its person, on
 * `run.workingMemory.unknownOutcomeCalls`. No arguments and no results: those
 * stay in the conversation and on the approval, never in working memory.
 */
export interface UnknownOutcomeCall {
  toolCallId: string;
  toolId: string;
  toolName: string;
  approvalId: string;
  /** Each attempt's number and outcome. */
  attempts: Array<Pick<WriteAttempt, 'attempt' | 'outcome' | 'httpStatus' | 'cutOff'>>;
}
