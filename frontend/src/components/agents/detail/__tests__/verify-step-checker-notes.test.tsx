/**
 * The check's verdict is its verdict findings; what else the checker said
 * is a checker note, shown on the run's verify step only. A check that
 * only reports blocks nothing, so it carries no "blocking" badge.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../../../test/setup'
import { VerifyStepCard } from '../verify-step'
import type { AgentRunStep } from '@/types'

const step = (output: Record<string, unknown>): AgentRunStep => ({ type: 'verify', timestamp: '2026-11-12T00:00:00Z', output } as AgentRunStep)

describe('the verify step card', () => {
  it('shows a report-only check without a "blocking" badge, and one that revises with it', () => {
    const { unmount } = render(<VerifyStepCard step={step({ verdict: 'pass', reportOnly: true, failures: [] })} index={0} />)
    expect(screen.queryByText('blocking')).toBeNull()
    unmount()
    render(<VerifyStepCard step={step({ verdict: 'pass', failures: [] })} index={0} />)
    expect(screen.getByText('blocking')).toBeInTheDocument()
  })

  it('lists checker notes under "Checker notes", apart from the findings, on a check that passed', () => {
    render(
      <VerifyStepCard
        step={step({
          verdict: 'pass',
          reportOnly: true,
          failures: [],
          notes: [
            { checker: 'Answer check', text: 'Issue #67427 does not have labels or title indicating bugs, regressions or security', claim: '5. [#67427] sqlite: should Database close its connection on garbage collection?' },
          ],
        })}
        index={2}
      />,
    )
    expect(screen.getByText('Check passed')).toBeInTheDocument()
    const notes = screen.getByTestId('checker-notes')
    expect(notes).toHaveTextContent('Checker notes')
    expect(notes).toHaveTextContent(/Issue #67427 does not have labels/)
    expect(notes).toHaveTextContent(/never change the verdict/)
    expect(screen.queryByTestId('verify-findings')).toBeNull()
  })

  it('shows the findings that decided a failed check, each naming what is wrong', () => {
    render(
      <VerifyStepCard
        step={step({
          verdict: 'fail',
          reportOnly: true,
          failures: [{ rule: 'dotenv: the answer says outdated-minor, but 16 to 18 is a major update', checker: 'code check', item: 'dotenv', field: 'status' }],
        })}
        index={2}
      />,
    )
    expect(screen.getByTestId('verify-findings')).toHaveTextContent('dotenv: the answer says outdated-minor, but 16 to 18 is a major update')
    expect(screen.queryByTestId('checker-notes')).toBeNull()
  })
})
