import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../../test/setup'
import {
  RunLimitsSection,
  DEFAULT_RUN_LIMITS,
  runLimitsSummary,
  type RunLimitsConfig,
} from '../run-limits-section'

const renderSection = (
  value: RunLimitsConfig = {},
  onChange = vi.fn(),
  inherited?: Parameters<typeof RunLimitsSection>[0]['inherited'],
  { open = true } = {},
) => {
  render(<RunLimitsSection value={value} onChange={onChange} inherited={inherited} />)
  if (open) fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
  return onChange
}

describe('RunLimitsSection', () => {
  it('says what the limits are in one line, with the fields closed', () => {
    renderSection({}, vi.fn(), undefined, { open: false })
    expect(screen.getByTestId('run-limits-summary')).toHaveTextContent(
      'Stops after 50 steps, $1 or 15 minutes, whichever comes first.',
    )
    expect(screen.queryByLabelText('Max steps')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Advanced/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('counts the organization and the agent in the line, smallest wins', () => {
    expect(runLimitsSummary({}, { maxSteps: 30, maxCostCents: 250 })).toBe(
      'Stops after 30 steps, $2.50 or 15 minutes, whichever comes first.',
    )
    expect(runLimitsSummary({ maxSteps: 20, maxDurationMs: 90_000 }, { maxSteps: 30 })).toBe(
      'Stops after 20 steps, $1 or 2 minutes, whichever comes first.',
    )
    expect(runLimitsSummary({ maxDurationMs: 2 * 3600_000 })).toMatch(/or 2 hours,/)
  })

  it('uses the same defaults as the server', () => {
    // Mirrors DEFAULT_RUN_LIMITS in backend run-limits.ts; the line would
    // otherwise promise a limit the server does not apply.
    const backend = readFileSync(
      join(__dirname, '../../../../../../backend/src/modules/agents/run-limits.ts'),
      'utf8',
    )
    const block = /DEFAULT_RUN_LIMITS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(backend)?.[1] ?? ''
    expect(block).toMatch(new RegExp(`maxSteps: ${DEFAULT_RUN_LIMITS.maxSteps},`))
    expect(block).toMatch(new RegExp(`maxCostCents: ${DEFAULT_RUN_LIMITS.maxCostCents},`))
    expect(block).toMatch(/maxDurationMs: 15 \* 60 \* 1000,/)
    expect(DEFAULT_RUN_LIMITS.maxDurationMs).toBe(15 * 60 * 1000)
  })

  it('leaves fields empty so nothing silently becomes this agent ceiling', () => {
    renderSection()
    expect(screen.getByLabelText('Max steps')).toHaveValue('')
    expect(screen.getByLabelText('Spending cap ($)')).toHaveValue('')
  })

  it('shows the inherited value so empty is legible', () => {
    renderSection({}, vi.fn(), { maxSteps: 50, maxCostCents: 100 })
    expect(screen.getByLabelText('Max steps')).toHaveAttribute('placeholder', 'Inherited: 50')
    expect(screen.getByLabelText('Spending cap ($)')).toHaveAttribute('placeholder', 'Inherited: $1')
  })

  it('takes the spending cap in dollars and stores cents', () => {
    const onChange = renderSection()
    fireEvent.change(screen.getByLabelText('Spending cap ($)'), { target: { value: '2.5' } })
    expect(onChange).toHaveBeenLastCalledWith({ maxCostCents: 250 })
    expect(screen.getByLabelText('Spending cap ($)')).toHaveValue('2.5')
  })

  it('renders an existing cap back in dollars', () => {
    renderSection({ maxCostCents: 150 })
    expect(screen.getByLabelText('Spending cap ($)')).toHaveValue('1.5')
  })

  it('reports a number the operator typed', () => {
    const onChange = renderSection()
    fireEvent.change(screen.getByLabelText('Max steps'), { target: { value: '20' } })
    expect(onChange).toHaveBeenCalledWith({ maxSteps: 20 })
  })

  it('treats an emptied field as inherit rather than zero', () => {
    // Zero would be a ceiling of nothing, which is not what clearing a
    // field means.
    const onChange = renderSection({ maxSteps: 20 })
    fireEvent.change(screen.getByLabelText('Max steps'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ maxSteps: null })
  })

  it('rejects junk and non-positive values instead of storing them', () => {
    const onChange = renderSection()
    for (const value of ['abc', '0', '-5']) {
      fireEvent.change(screen.getByLabelText('Max steps'), { target: { value } })
      expect(onChange).toHaveBeenLastCalledWith({ maxSteps: null })
    }
  })

  it('shows the timeout in seconds but stores milliseconds', () => {
    const onChange = renderSection()
    fireEvent.change(screen.getByLabelText('Timeout (seconds)'), { target: { value: '90' } })
    expect(onChange).toHaveBeenCalledWith({ maxDurationMs: 90_000 })
  })

  it('renders an existing timeout back in seconds', () => {
    renderSection({ maxDurationMs: 120_000 })
    expect(screen.getByLabelText('Timeout (seconds)')).toHaveValue('120')
  })

  it('offers the three truncation policies', () => {
    renderSection()
    expect(screen.getByLabelText('When the context budget runs out')).toBeInTheDocument()
  })

  it('offers the three tool-error feedback policies', () => {
    renderSection()
    expect(screen.getByLabelText('When a tool call fails')).toBeInTheDocument()
  })

  it('explains that a per-tool retry count still wins', () => {
    renderSection()
    expect(screen.getByText(/own retry count still wins/)).toBeInTheDocument()
  })

  it('says an agent can only tighten, never raise', () => {
    renderSection()
    expect(screen.getByText(/only tighten/)).toBeInTheDocument()
  })

  it('keeps its fields behind the shared Disclosure, not a hand-rolled toggle', () => {
    const src = readFileSync(join(__dirname, '..', 'run-limits-section.tsx'), 'utf8')
    expect(src).toMatch(/from '@\/components\/ui\/disclosure'/)
    expect(src).toMatch(/<Disclosure title="Advanced"/)
  })
})
