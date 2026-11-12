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
            ? 'Passed verification'
            : unavailable
              ? 'Check could not be done: no checker gave a verdict'
              : advisory
                ? 'Flagged issues (advisory)'
                : 'Failed verification'}
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
      </div>
    </div>
  )
}

/** Run-level verification verdict banner, from `run.metadata.verify` (or, when a run did not record one, its last blocking check). */
export function VerifySummary({ run }: { run: AgentRun }) {
  const v = run.metadata?.verify ?? (unverifiedAnswer(run) ? { verdict: 'fail', exhausted: true } : null)
  if (!v) return null
  const passed = v.verdict === 'pass'
  const unavailable = !passed && uncheckedAnswer(run)
  const revisions = typeof v.revisions === 'number' ? v.revisions : 0

  return (
    <div
      className={`flex items-center gap-2 p-2 rounded text-xs ${
        passed
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : unavailable
            ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200'
            : 'bg-destructive/10 text-destructive'
      }`}
    >
      {passed ? <CheckCircle2 className="h-4 w-4" /> : unavailable ? <ShieldAlert className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      <span className="font-medium">
        {passed ? 'Verification passed' : unavailable ? 'Verification could not be done' : 'Verification failed'}
      </span>
      {revisions > 0 && (
        <span>
          · {pluralized(revisions, 'revision')}
        </span>
      )}
      {v.exhausted && <span>· budget exhausted</span>}
    </div>
  )
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

const UNVERIFIED_LINE = 'Not verified: the checkers still found problems with this answer when the revisions ran out.'
const UNCHECKED_LINE = 'Not checked: the check could not be done, so no checker gave a verdict on this answer.'

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
        {unchecked ? 'Not checked' : 'Not verified'}
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