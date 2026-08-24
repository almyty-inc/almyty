import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { RunLimitsSection, type RunLimitsConfig } from '../run-limits-section'

const renderSection = (
  value: RunLimitsConfig = {},
  onChange = vi.fn(),
  inherited?: Parameters<typeof RunLimitsSection>[0]['inherited'],
) => {
  render(<RunLimitsSection value={value} onChange={onChange} inherited={inherited} />)
  return onChange
}

describe('RunLimitsSection', () => {
  it('leaves fields empty so nothing silently becomes this agent ceiling', () => {
    renderSection()
    expect(screen.getByLabelText('Max steps')).toHaveValue('')
    expect(screen.getByLabelText('Cost cap (cents)')).toHaveValue('')
  })

  it('shows the inherited value so empty is legible', () => {
    renderSection({}, vi.fn(), { maxSteps: 50, maxCostCents: 100 })
    expect(screen.getByLabelText('Max steps')).toHaveAttribute('placeholder', 'Inherited: 50')
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
})
