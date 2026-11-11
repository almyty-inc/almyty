import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RunStatusBadge } from '../run-status-badge'
import { presentationForRun } from '@/lib/run-status'
import type { AgentRunStatus } from '@/types/runtime'

/**
 * Every state of the runtime union has its own label and tone, so no run
 * falls through to a default. `sleeping` is a pause, never an end.
 */
const ALL: Record<AgentRunStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  waiting_input: 'Waiting for input',
  waiting_approval: 'Waiting for approval',
  sleeping: 'Sleeping',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
}

describe('RunStatusBadge', () => {
  it.each(Object.entries(ALL))('labels %s as "%s"', (status, label) => {
    render(<RunStatusBadge status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(presentationForRun(status).label).not.toBe('Status unavailable')
  })

  it('treats only completed, failed, cancelled and timeout as final', () => {
    const final = Object.keys(ALL).filter((s) => presentationForRun(s).terminal)
    expect(final.sort()).toEqual(['cancelled', 'completed', 'failed', 'timeout'])
    expect(presentationForRun('sleeping').terminal).toBe(false)
  })

  it('says it does not know an unknown status instead of guessing one', () => {
    render(<RunStatusBadge status="hibernating" />)
    expect(screen.getByText('Status unavailable')).toBeInTheDocument()
  })

  it('pairs each tone with a label and an icon, never colour alone', () => {
    const { container } = render(<RunStatusBadge status="failed" />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })
})
