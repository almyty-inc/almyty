import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { WaitingApprovalNote, runStatusLabel } from '../waiting-approval'

const note = (run: { status: string; error?: string | null }) =>
  render(
    <MemoryRouter>
      <WaitingApprovalNote run={run} />
    </MemoryRouter>,
  )

describe('WaitingApprovalNote (Recent runs)', () => {
  it('says a run waits for approval, how many changes, and links to Approvals', () => {
    note({ status: 'waiting_approval', error: 'Waiting for your approval: 3 changes.' })
    expect(screen.getByText(/Waiting for your approval: 3 changes\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open approvals' })).toHaveAttribute('href', '/approvals')
  })

  it('says plainly that a run ended because its changes were rejected', () => {
    note({ status: 'cancelled', error: 'Rejected. None of the 3 changes ran.' })
    expect(screen.getByText('Rejected. None of the 3 changes ran.')).toBeInTheDocument()
  })

  it('adds nothing under other runs', () => {
    const { container } = note({ status: 'cancelled', error: 'Execution cancelled' })
    expect(container).toBeEmptyDOMElement()
  })

  it('labels the status in words', () => {
    expect(runStatusLabel('waiting_approval')).toBe('waiting for approval')
    expect(runStatusLabel('waiting_input')).toBe('waiting input')
  })
})
