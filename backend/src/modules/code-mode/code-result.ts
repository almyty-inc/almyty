/**
 * What the model reads back from run_code (docs/design/code-mode.md, part
 * C): the return value and the log (each already capped with the
 * truncation marker), the error with what already happened, and the change
 * set. Kept small: a staged entry's arguments and a committed call's
 * arguments are dropped first when the whole answer would be too long.
 */
import type { ChangeSetEntry } from '../../entities/code-execution.entity';
import type { RunCodeOutcome } from './code-mode.service';

export interface CodeResultForModel {
  status: 'completed' | 'failed' | 'waiting_for_approval';
  result?: unknown;
  logs?: string;
  error?: RunCodeOutcome['error'];
  committed?: Array<{ tool: string; arguments?: Record<string, any> }>;
  staged?: Array<{ id: number; tool: string; arguments?: Record<string, any>; rule?: string }>;
  calls: { made: number; ran: number; failed: number; staged: number; refused: number };
  note?: string;
}

export function codeResultForModel(outcome: RunCodeOutcome, maxChars: number): CodeResultForModel {
  const count = (o: string) => outcome.calls.filter((c) => c.outcome === o).length;
  const out: CodeResultForModel = {
    status: outcome.status === 'waiting_approval' ? 'waiting_for_approval' : outcome.status === 'failed' ? 'failed' : 'completed',
    ...(outcome.error ? {} : { result: outcome.result }),
    ...(outcome.logs ? { logs: outcome.logs } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    calls: { made: outcome.calls.length, ran: count('ran'), failed: count('failed'), staged: count('staged'), refused: count('refused') },
  };
  if (outcome.committed.length && (outcome.error || outcome.staged.length)) {
    out.committed = outcome.committed.map((c) => ({ tool: c.tool, arguments: c.arguments }));
  }
  if (outcome.staged.length) {
    out.staged = outcome.staged.map((e) => ({ id: e.id, tool: e.codeName, arguments: e.arguments, ...(e.rule ? { rule: e.rule } : {}) }));
    out.note = outcome.error
      ? `The script failed, so its ${outcome.staged.length} staged change(s) were dropped: none of them ran.`
      : `${outcome.staged.length} change(s) are waiting for a person to approve them. None has run yet; the outcome comes back before your next step.`;
  }
  if (outcome.error && outcome.staged.length) out.status = 'failed';
  if (JSON.stringify(out).length > maxChars) {
    if (out.staged) out.staged = out.staged.map(({ arguments: _a, ...rest }) => rest);
    if (out.committed) out.committed = out.committed.map(({ arguments: _a, ...rest }) => rest);
  }
  return out;
}

/** The answer once a person decided the change set (decision 7: stop at the first failure, roll nothing back). */
export function changeSetOutcomeForModel(
  before: CodeResultForModel,
  decision: 'approved' | 'rejected' | 'expired',
  entries: ChangeSetEntry[],
  reason?: string | null,
): Record<string, unknown> {
  const ran = entries.filter((e) => e.outcome === 'ran').map((e) => ({ id: e.id, tool: e.codeName }));
  const failed = entries.filter((e) => e.outcome === 'failed').map((e) => ({ id: e.id, tool: e.codeName, error: e.error }));
  const notRun = entries.filter((e) => e.outcome === 'not_run').map((e) => ({ id: e.id, tool: e.codeName }));
  const note =
    decision === 'approved'
      ? failed.length
        ? `A person approved the changes. ${ran.length} ran; change ${failed[0].id} failed, so the ${notRun.length} after it did not run. Nothing was rolled back.`
        : `A person approved the changes, and all ${ran.length} ran.`
      : decision === 'expired'
        ? 'Nobody decided on the changes in time. None of them ran.'
        : `A person rejected the changes${reason ? ` (${reason})` : ''}. None of them ran.`;
  const { note: _old, status: _status, ...rest } = before;
  return { ...rest, status: decision === 'approved' ? 'completed' : 'rejected', changeSet: { decision, ran, failed, notRun }, note };
}
