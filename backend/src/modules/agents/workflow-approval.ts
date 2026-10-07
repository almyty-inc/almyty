/**
 * A workflow run that waits for a person (docs-site/content/agents/node-types.mdx,
 * "Code" and "Tool call"). A Code step whose script asked for changes a
 * person must approve, or a Tool call step an approval rule held, stops the
 * run in `waiting_approval`; once everything it waits on is decided,
 * WorkflowApprovalResumeService carries the run on from that step. The words
 * here are the ones people read: on the run, its step, the overview. What
 * the model reads about a change set is code-mode/code-result.ts.
 */
import type { ChangeSetEntry } from '../../entities/code-execution.entity';
import { readableToolName } from '../tools/tool-readable-name';

/** A node error's code while its step waits for a person. */
export const WAITING_FOR_APPROVAL_CODE = 'AWAITING_APPROVAL';
/** A node error's code once its step's changes were rejected (or nobody decided in time). */
export const APPROVAL_REJECTED_CODE = 'APPROVAL_REJECTED';

/** One step the run waits on, kept on the run's metadata until it is decided. */
export interface WaitingCodeStep {
  nodeId: string;
  /** A Code step's change set (the default), or one Tool call an approval rule held. */
  kind?: 'code' | 'tool_call';
  approvalId: string;
  codeExecutionId: string | null;
  /** How many changes wait: a change set's entries, or 1 for a held call. */
  changes: number;
  /** What the script returned: the step's output once its changes are approved. */
  result?: unknown;
  /** A held call in plain words: "Issue refund (amount is 820)". */
  call?: string;
}

/** What `metadata.waitingForApproval` holds while a run waits. */
export interface WorkflowWaitState {
  steps: WaitingCodeStep[];
  /** The run's tool-call ledger when it stopped, so the budget carries on from there. */
  toolCalls: number;
  /** The graph that ran, so the run carries on in the same one even if the agent is edited meanwhile. */
  pipeline: { nodes: any[]; edges: any[] };
  variables?: Record<string, any>;
  principal?: unknown;
}

/** What a decided step comes back as when the run carries on. */
export interface SettledCodeStep {
  output?: unknown;
  error?: string;
  errorCode?: string;
}

export function changesWord(n: number): string {
  return `${n} change${n === 1 ? '' : 's'}`;
}

/** "Waiting for your approval: 3 changes." */
export function waitingForApprovalText(changes: number): string {
  return `Waiting for your approval: ${changesWord(changes)}.`;
}

/** A held call as a person reads it: "Issue refund (amount is 820)". */
export function heldCallWords(toolName: string, why?: string | null): string {
  const name = readableToolName({ name: toolName } as any);
  return why ? `${name} (${why})` : name;
}

/** "Waiting for your approval: Issue refund (amount is 820)." */
export function waitingForCallText(call: string): string {
  return `Waiting for your approval: ${call}.`;
}

/** The run's line while it waits, across every step it waits on. */
export function waitingRunText(steps: Array<Pick<WaitingCodeStep, 'changes' | 'kind' | 'call'>>): string {
  const calls = steps.filter((s) => s.kind === 'tool_call');
  if (!calls.length) return waitingForApprovalText(steps.reduce((sum, s) => sum + (s.changes || 0), 0));
  if (steps.length === 1) return waitingForCallText(calls[0].call || 'a tool call');
  return `Waiting for your approval: ${steps.length} requests.`;
}

/**
 * A decided change set, as its step's outcome: approved and all ran, the
 * script's result; approved with a change that failed, which one and what
 * did not run; rejected or expired, a plain "Rejected" and nothing ran.
 */
export function settledCodeStep(
  decision: 'approved' | 'rejected' | 'expired',
  entries: ChangeSetEntry[],
  result: unknown,
  reason?: string | null,
): SettledCodeStep {
  const n = entries.length;
  if (decision === 'approved') {
    const failedAt = entries.findIndex((e) => e.outcome === 'failed');
    if (failedAt < 0) return { output: result ?? null };
    const ran = entries.filter((e) => e.outcome === 'ran').length;
    const why = entries[failedAt].error ? `: ${entries[failedAt].error}` : '';
    return {
      error: `Approved, but change ${failedAt + 1} of ${n} failed${why}. ${ran} ran before it; the rest did not run.`,
    };
  }
  if (decision === 'expired') {
    return { error: `Nobody approved in time. None of the ${changesWord(n)} ran.`, errorCode: APPROVAL_REJECTED_CODE };
  }
  const said = reason && reason.trim() ? ` (${reason.trim()})` : '';
  return { error: `Rejected${said}. None of the ${changesWord(n)} ran.`, errorCode: APPROVAL_REJECTED_CODE };
}

/**
 * A decided held call, as its step's outcome: approved, what the call
 * returned (made once, by the approval gate); approved but the call failed,
 * that it failed and why; rejected or expired, a plain "Rejected" and the
 * call was not made.
 */
export function settledHeldCall(
  decision: 'approved' | 'rejected' | 'expired',
  outcome: { success?: boolean; data?: unknown; error?: string | null } | null,
  reason?: string | null,
): SettledCodeStep {
  if (decision === 'approved') {
    if (outcome?.success) return { output: outcome.data ?? null };
    return { error: `Approved, but the call failed${outcome?.error ? `: ${outcome.error}` : ''}.` };
  }
  if (decision === 'expired') {
    return { error: 'Nobody approved in time. The call was not made.', errorCode: APPROVAL_REJECTED_CODE };
  }
  const said = reason && reason.trim() ? ` (${reason.trim()})` : '';
  return { error: `Rejected${said}. The call was not made.`, errorCode: APPROVAL_REJECTED_CODE };
}
