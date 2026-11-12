/**
 * Verify-step rendering for the run transcript. The autonomous verifier records
 * `verify` steps (final-output gate revisions + advisory mid-run checks) and a
 * run-level `metadata.verify` verdict; these surface the loop's self-correction
 * so a run reads as "drafted → refuted → revised" instead of an opaque result.
 */
import { CheckCircle2, XCircle, ShieldCheck, ShieldAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { formatDuration } from './constants'
import type { AgentRun, AgentRunStep } from '@/types'
import { StepRoleLine } from './run-roles'
import { pluralized } from '@/lib/utils'

/**
 * One wording for a check everywhere a run is shown (the runs list, the run
 * view, its banner and its steps), matching the line on the answer itself
 * ("Note: this answer's check didn't pass", unverified-answer.ts).
 */
export const CHECK_PASSED = 'Check passed'
export const CHECK_FAILED = "Check didn't pass"
export const NOT_CHECKED = 'Not checked'

interface VerifyFailure {
  rule?: string
  evidence?: string
  checker?: string
  claim?: string
}

interface CheckerVerdict {
  checker?: string
  verdict?: string
  error?: string
  note?: string
}

/** Distinct card for a `verify` step inside a run's step list. */
export function VerifyStepCard({ step, index }: { step: AgentRunStep; index: number }) {
  const out = step.output || {}
  const passed = out.verdict === 'pass'
  // No checker gave a verdict: the answer was not checked, nothing was found wrong.
  const unavailable = !passed && out.unavailable === true
  const advisory = out.advisory === true || step.input?.mode === 'mid_loop'
  const failures: VerifyFailure[] = Array.isArray(out.failures) ? out.failures : []
  const checkers: CheckerVerdict[] = Array.isArray(out.checkers) ? out.checkers : []
  const checkerLines = checkers.filter((c) => c?.error || c?.note)
  const inputTokens = Number(step.tokens?.input) || 0

  return (
    <div
      className={`flex items-start gap-3 p-2 rounded border text-sm ${
        passed
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : unavailable
            ? 'border-amber-500/40 bg-amber-500/5'
            : 'border-destructive/30 bg-destructive/5'
      }`}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs font-mono text-muted-foreground">#{index + 1}</span>
        {passed ? (
          <ShieldCheck className="h-4 w-4 text-emerald-500" />
        ) : (
          <ShieldAlert className={`h-4 w-4 ${unavailable ? 'text-amber-500' : 'text-destructive'}`} />
        )}
        <Badge variant="outline" className="text-[10px]">verify</Badge>
        <Badge variant="outline" className="text-[10px]">{advisory ? 'mid-run' : 'blocking'}</Badge>
        {typeof out.revision === 'number' && (
          <Badge variant="outline" className="text-[10px]">revision {out.revision}</Badge>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <StepRoleLine step={step} />
        <div className="text-xs font-medium">
          {passed
            ? CHECK_PASSED
            : unavailable
              ? `${NOT_CHECKED}: no checker gave a verdict`
              : advisory
                ? 'Flagged issues (advisory)'
                : CHECK_FAILED}
          {out.exhausted ? ' — revision budget exhausted' : ''}
        </div>
        {failures.length > 0 && !unavailable && (
          <ul className="mt-1 space-y-0.5">
            {failures.map((f, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                {f.claim ? <span className="text-foreground">“{f.claim}”: </span> : null}
                <span className="text-foreground">{f.rule || 'issue'}</span>
                {f.evidence ? ` — ${f.evidence}` : ''}
                {f.checker ? ` (${f.checker})` : ''}
              </li>
            ))}
          </ul>
        )}
        {checkerLines.length > 0 && (
          <ul className="mt-1 space-y-0.5" data-testid="verify-checker-notes">
            {checkerLines.map((c, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                {c.checker ? `${c.checker}: ` : ''}
                {c.error ?? c.note}
                {c.error && c.note ? ` (${c.note})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground shrink-0 text-right">
        {step.duration ? formatDuration(step.duration) : ''}
        {step.cost ? ` / $${step.cost.toFixed(4)}` : ''}
        {/* What the checker read: the evidence is most of it, and it is paid again on every check. */}
        {inputTokens > 0 && <div data-testid="verify-input-tokens">{pluralized(inputTokens, 'token')} read</div>}
      </div>
    </div>
  )
}

/**
 * Run-level check banner, from `run.metadata.verify` (or, when a run did not
 * record one, its last blocking check), with the first reason when the
 * check did not pass.
 */
export function VerifySummary({ run }: { run: AgentRun }) {
  const v = run.metadata?.verify ?? (unverifiedAnswer(run) ? { verdict: 'fail', exhausted: true } : null)
  if (!v) return null
  const passed = v.verdict === 'pass'
  const unavailable = !passed && uncheckedAnswer(run)
  const revisions = typeof v.revisions === 'number' ? v.revisions : 0
  const reason = passed ? '' : firstReason(run)

  return (
    <div
      data-testid="verify-summary"
      className={`flex items-start gap-2 p-2 rounded text-xs ${
        passed
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : unavailable
            ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200'
            : 'bg-destructive/10 text-destructive'
      }`}
    >
      {passed ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : unavailable ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="font-medium">{passed ? CHECK_PASSED : unavailable ? NOT_CHECKED : CHECK_FAILED}</span>
          {revisions > 0 && <span>· {pluralized(revisions, 'revision')}</span>}
          {v.exhausted && <span>· budget exhausted</span>}
        </div>
        {reason && <div data-testid="verify-summary-reason">{reason}</div>}
      </div>
    </div>
  )
}

/** The first reason a check did not pass: the one the run recorded, else the last blocking check's first failure. */
function firstReason(run: VerdictCarrier): string {
  const recorded = run?.metadata?.verify?.reason
  if (typeof recorded === 'string' && recorded.trim()) return recorded.trim()
  const failures = lastBlockingCheck(run)?.output?.failures
  const first = Array.isArray(failures) ? failures.find((f: any) => typeof f?.rule === 'string' && f.rule.trim()) : null
  return first ? String(first.rule).trim() : ''
}

type VerdictCarrier = {
  status?: string
  metadata?: Record<string, any> | null
  steps?: Array<{ type?: string; input?: any; output?: any }> | null
} | null | undefined

function lastBlockingCheck(run: VerdictCarrier) {
  const steps = Array.isArray(run?.steps) ? run!.steps! : []
  return [...steps]
    .reverse()
    .find((s) => s?.type === 'verify' && s.output?.advisory !== true && s.input?.mode !== 'mid_loop')
}

/**
 * Whether a finished run's answer went out without passing its check: the
 * checkers still failed it when the revisions ran out, or no checker could
 * give a verdict. The run records that in `metadata.verify`; a run checked
 * in patch mode only in its last blocking `verify` step, so both are read.
 */
export function unverifiedAnswer(run: VerdictCarrier): boolean {
  if (!run || (run.status && run.status !== 'completed')) return false
  const v = run.metadata?.verify
  if (v && typeof v.verdict === 'string') return v.verdict !== 'pass'
  const last = lastBlockingCheck(run)
  return !!last && last.output?.verdict !== 'pass' && (last.output?.exhausted === true || last.output?.unavailable === true)
}

/** Whether the answer went out unchecked: no checker could give a verdict on it. Nothing was found wrong with it. */
export function uncheckedAnswer(run: VerdictCarrier): boolean {
  if (!unverifiedAnswer(run)) return false
  const v = run?.metadata?.verify
  if (v && typeof v.verdict === 'string') return v.unavailable === true
  return lastBlockingCheck(run)?.output?.unavailable === true
}

const UNVERIFIED_LINE = `${CHECK_FAILED}: the checkers still found problems with this answer when the revisions ran out.`
const UNCHECKED_LINE = `${NOT_CHECKED}: the check could not be done, so no checker gave a verdict on this answer.`

/**
 * The marker on an answer that went out without passing its check.
 * `compact` is the badge for a row in a list; otherwise a line above the answer.
 */
export function UnverifiedNote({ run, compact, className = '' }: { run: unknown; compact?: boolean; className?: string }) {
  if (!unverifiedAnswer(run as VerdictCarrier)) return null
  const unchecked = uncheckedAnswer(run as VerdictCarrier)
  const line = unchecked ? UNCHECKED_LINE : UNVERIFIED_LINE
  if (compact) {
    return (
      <Badge
        variant="outline"
        title={line}
        data-testid="unverified-badge"
        className={`ml-1 gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300 ${className}`}
      >
        <ShieldAlert className="h-3 w-3" aria-hidden />
        {unchecked ? NOT_CHECKED : CHECK_FAILED}
      </Badge>
    )
  }
  return (
    <div
      role="note"
      data-testid="unverified-note"
      className={`flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200 ${className}`}
    >
      <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
      <span>{line}</span>
    </div>
  )
}