import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../../../test/setup'
import { UnverifiedNote, VerifyStepCard, VerifySummary } from '../verify-step'
import type { AgentRun, AgentRunStep } from '@/types'

const step = (over: Partial<AgentRunStep>): AgentRunStep =>
  ({ type: 'verify', timestamp: '2026-06-24T00:00:00Z', ...over } as AgentRunStep)

const run = (metadata: any): AgentRun => ({ metadata } as AgentRun)

describe('VerifyStepCard', () => {
  it('renders a passing gate verdict', () => {
    render(<VerifyStepCard step={step({ output: { verdict: 'pass', failures: [] } })} index={0} />)
    expect(screen.getByText('Check passed')).toBeInTheDocument()
    expect(screen.getByText('blocking')).toBeInTheDocument()
  })

  it('renders a failed gate revision with its failures', () => {
    render(
      <VerifyStepCard
        step={step({
          output: {
            verdict: 'fail',
            revision: 2,
            failures: [{ rule: 'missing total', evidence: 'no sum line', checker: 'c1' }],
          },
        })}
        index={1}
      />,
    )
    expect(screen.getByText("Check didn't pass")).toBeInTheDocument()
    expect(screen.getByText('revision 2')).toBeInTheDocument()
    expect(screen.getByText(/missing total/)).toBeInTheDocument()
    expect(screen.getByText(/no sum line/)).toBeInTheDocument()
  })

  it('renders an advisory mid-run check', () => {
    render(
      <VerifyStepCard
        step={step({ input: { mode: 'mid_loop' }, output: { verdict: 'fail', advisory: true, failures: [] } })}
        index={2}
      />,
    )
    expect(screen.getByText('Flagged issues (advisory)')).toBeInTheDocument()
    expect(screen.getByText('mid-run')).toBeInTheDocument()
  })
})

describe('VerifySummary', () => {
  it('renders nothing without a verify verdict', () => {
    const { container } = render(<VerifySummary run={run(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a passing verdict', () => {
    render(<VerifySummary run={run({ verify: { verdict: 'pass', revisions: 0 } })} />)
    expect(screen.getByText('Check passed')).toBeInTheDocument()
  })

  it('renders a failed verdict with revisions and exhausted budget', () => {
    render(<VerifySummary run={run({ verify: { verdict: 'fail', revisions: 2, exhausted: true } })} />)
    expect(screen.getByText("Check didn't pass")).toBeInTheDocument()
    expect(screen.getByText(/2 revisions/)).toBeInTheDocument()
    expect(screen.getByText(/budget exhausted/)).toBeInTheDocument()
  })
})

// Run b9803830: no checker gave a verdict (each reply was cut off), and the
// run view said "the checkers still found problems" and showed the internal
// code. A check that could not be done says so, in plain words.
describe('a check no checker could give a verdict on', () => {
  const unchecked = {
    status: 'completed',
    metadata: { verify: { verdict: 'fail', revisions: 0, exhausted: false, unavailable: true, reason: 'the checker could not give a verdict' } },
  } as unknown as AgentRun

  it('says the check could not be done, not that problems were found', () => {
    render(<VerifySummary run={unchecked} />)
    expect(screen.getByText('Not checked')).toBeInTheDocument()
    expect(screen.queryByText("Check didn't pass")).not.toBeInTheDocument()
  })

  it('marks the answer as not checked', () => {
    render(<UnverifiedNote run={unchecked} />)
    const note = screen.getByTestId('unverified-note')
    expect(note).toHaveTextContent('Not checked: the check could not be done')
    expect(note).not.toHaveTextContent(/found problems/)
    expect(note).not.toHaveTextContent(/verification_unavailable/)
  })

  it('keeps the "found problems" line for an answer the checkers did fail', () => {
    render(<UnverifiedNote run={{ status: 'completed', metadata: { verify: { verdict: 'fail', exhausted: true } } }} />)
    expect(screen.getByTestId('unverified-note')).toHaveTextContent(/found problems with this answer/)
  })

  // By default the check only reports: no revision ran, so the line must
  // not say the revisions ran out.
  it('marks a reported (not revised) failed check without talking about revisions', () => {
    const reported = { status: 'completed', metadata: { verify: { verdict: 'fail', revisions: 0, exhausted: false, reportOnly: true } } }
    render(
      <>
        <UnverifiedNote run={reported} />
        <VerifySummary run={reported as unknown as AgentRun} />
      </>,
    )
    expect(screen.getByTestId('unverified-note')).toHaveTextContent("Check didn't pass: the checkers found problems with this answer.")
    expect(document.body).not.toHaveTextContent(/revisions ran out|budget exhausted/)
  })

  it('reads a report-only last check as an unverified answer when the run recorded no verdict', () => {
    const run = {
      status: 'completed',
      steps: [{ type: 'verify', output: { verdict: 'fail', reportOnly: true, exhausted: false, failures: [{ rule: 'wrong total' }] } }],
    }
    render(<UnverifiedNote run={run} compact />)
    expect(screen.getByTestId('unverified-badge')).toHaveTextContent("Check didn't pass")
  })

  it('shows on the step why each checker gave no verdict', () => {
    render(
      <VerifyStepCard
        step={step({
          output: {
            verdict: 'fail',
            unavailable: true,
            failures: [{ rule: 'the checker could not give a verdict', checker: 'verify', code: 'verification_unavailable' }],
            checkers: [{ checker: 'checker_1', verdict: 'error', error: "the checker's reply was cut off at its output limit (4096 tokens) before it gave a verdict" }],
          },
        })}
        index={0}
      />,
    )
    expect(screen.getByText('Not checked: no checker gave a verdict')).toBeInTheDocument()
    expect(screen.getByTestId('verify-checker-notes')).toHaveTextContent(/checker_1: the checker's reply was cut off at its output limit/)
    expect(screen.queryByText("Check didn't pass")).not.toBeInTheDocument()
  })
})

// The runs list said "Not verified" and the run view "Verification failed"
// for the same run. One plain wording everywhere, as on the answer itself.
describe('one wording for a check', () => {
  const failed = {
    status: 'completed',
    metadata: { verify: { verdict: 'fail', revisions: 2, exhausted: true, reason: 'Paper not found in the tool results for the query' } },
  } as unknown as AgentRun

  it('the runs list badge, the answer note and the run banner all say "Check didn\'t pass"', () => {
    render(
      <>
        <UnverifiedNote run={failed} compact />
        <UnverifiedNote run={failed} />
        <VerifySummary run={failed} />
      </>,
    )
    expect(screen.getByTestId('unverified-badge')).toHaveTextContent("Check didn't pass")
    expect(screen.getByTestId('unverified-note')).toHaveTextContent(/^Check didn't pass: /)
    expect(screen.getByTestId('verify-summary')).toHaveTextContent("Check didn't pass")
    expect(document.body).not.toHaveTextContent(/Not verified|Verification failed|Failed verification/)
  })

  it('the banner shows the first reason', () => {
    render(<VerifySummary run={failed} />)
    expect(screen.getByTestId('verify-summary-reason')).toHaveTextContent('Paper not found in the tool results for the query')
  })

  it('the banner falls back to the last check\'s first failure', () => {
    const run = {
      status: 'completed',
      steps: [{ type: 'verify', input: { mode: 'patch' }, output: { verdict: 'fail', exhausted: true, failures: [{ rule: '' }, { rule: 'Version mismatch for lodash' }] } }],
    } as unknown as AgentRun
    render(<VerifySummary run={run} />)
    expect(screen.getByTestId('verify-summary-reason')).toHaveTextContent('Version mismatch for lodash')
  })

  it('a check that could not be done says "Not checked" everywhere', () => {
    const unchecked = { status: 'completed', metadata: { verify: { verdict: 'fail', unavailable: true } } } as unknown as AgentRun
    render(
      <>
        <UnverifiedNote run={unchecked} compact />
        <VerifySummary run={unchecked} />
      </>,
    )
    expect(screen.getByTestId('unverified-badge')).toHaveTextContent('Not checked')
    expect(screen.getByTestId('verify-summary')).toHaveTextContent('Not checked')
  })
})

describe('a verify card shows what the checker read', () => {
  it('shows its input tokens', () => {
    render(<VerifyStepCard step={step({ cost: 0.0151, tokens: { input: 48213, output: 412 }, output: { verdict: 'fail', failures: [] } })} index={0} />)
    expect(screen.getByTestId('verify-input-tokens')).toHaveTextContent('48,213 tokens read')
  })
})