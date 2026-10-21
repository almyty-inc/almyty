/**
 * A hosted machine's problem, wherever it shows (the Hosted tab, the
 * environment page, a run's trace): a short sentence in the status-label
 * look, and the machine's own error, masked, behind "Details".
 */
import { StatusLabel } from '@/components/connect/status-label'

import type { MachineProblemInfo } from './hosted-shared'

export function MachineProblem({ problem, testId = 'machine-problem' }: { problem: MachineProblemInfo; testId?: string }) {
  return (
    <div className="max-w-xs space-y-0.5" data-testid={testId}>
      <StatusLabel check={{ state: 'failed', label: problem.summary }} testId={`${testId}-status`} />
      {problem.detail && (
        <details className="text-xs text-muted-foreground" onClick={(e) => e.stopPropagation()}>
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 break-words font-mono" data-testid={`${testId}-detail`}>{problem.detail}</p>
        </details>
      )}
    </div>
  )
}
