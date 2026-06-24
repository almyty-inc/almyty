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

interface VerifyFailure {
  rule?: string
  evidence?: string
  checker?: string
}

/** Distinct card for a `verify` step inside a run's step list. */
export function VerifyStepCard({ step, index }: { step: AgentRunStep; index: number }) {
  const out = step.output || {}
  const passed = out.verdict === 'pass'
  const advisory = out.advisory === true || step.input?.mode === 'mid_loop'
  const failures: VerifyFailure[] = Array.isArray(out.failures) ? out.failures : []

  return (
    <div
      className={`flex items-start gap-3 p-2 rounded border text-sm ${
        passed ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-destructive/30 bg-destructive/5'
      }`}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs font-mono text-muted-foreground">#{index + 1}</span>
        {passed ? (
          <ShieldCheck className="h-4 w-4 text-emerald-500" />
        ) : (
          <ShieldAlert className="h-4 w-4 text-destructive" />
        )}
        <Badge variant="outline" className="text-[10px]">verify</Badge>
        <Badge variant="outline" className="text-[10px]">{advisory ? 'mid-run' : 'gate'}</Badge>
        {typeof out.revision === 'number' && (
          <Badge variant="outline" className="text-[10px]">revision {out.revision}</Badge>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">
          {passed
            ? 'Passed verification'
            : advisory
              ? 'Flagged issues (advisory)'
              : 'Failed verification'}
          {out.exhausted ? ' — revision budget exhausted' : ''}
        </div>
        {failures.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {failures.map((f, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                <span className="text-foreground">{f.rule || 'issue'}</span>
                {f.evidence ? ` — ${f.evidence}` : ''}
                {f.checker ? ` (${f.checker})` : ''}
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

/** Run-level verification verdict banner, from `run.metadata.verify`. */
export function VerifySummary({ run }: { run: AgentRun }) {
  const v = run.metadata?.verify
  if (!v) return null
  const passed = v.verdict === 'pass'
  const revisions = typeof v.revisions === 'number' ? v.revisions : 0

  return (
    <div
      className={`flex items-center gap-2 p-2 rounded text-xs ${
        passed
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-destructive/10 text-destructive'
      }`}
    >
      {passed ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      <span className="font-medium">Verification {passed ? 'passed' : 'failed'}</span>
      {revisions > 0 && (
        <span>
          · {revisions} revision{revisions !== 1 ? 's' : ''}
        </span>
      )}
      {v.exhausted && <span>· budget exhausted</span>}
    </div>
  )
}
