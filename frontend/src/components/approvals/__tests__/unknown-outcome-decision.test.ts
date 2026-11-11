import { describe, it, expect } from 'vitest'

import { decisionMessage, isUnknownOutcome } from '@/pages/approvals'

/**
 * A call cut off when the worker running it stopped (it may already have
 * happened) and tried again: the person decides whether the agent carries
 * on with it or without it. Neither cancels the run, and neither sends the
 * call again; the confirm sentence must not say otherwise.
 */
describe('a call whose outcome was lost, awaiting approval', () => {
  const row = {
    payload: {
      kind: 'unknown_outcome',
      tool: 'Send the customer a message',
      parameters: { to: '*****ez@example.com' },
      attempts: [{ attempt: 1, outcome: 'unknown', httpStatus: 503 }, { attempt: 2, outcome: 'succeeded' }],
    },
  }

  it('is told apart from other requests', () => {
    expect(isUnknownOutcome(row)).toBe(true)
    expect(isUnknownOutcome({ payload: { tool: 'x', parameters: {} } })).toBe(false)
    expect(isUnknownOutcome({ payload: null })).toBe(false)
  })

  it('says rejecting carries on without the action, and never that the run is cancelled', () => {
    expect(decisionMessage(row, 'reject')).toBe(
      'Nothing is sent again or undone. The agent is told to treat this action as not done, and carries on without it.',
    )
    expect(decisionMessage(row, 'reject')).not.toMatch(/cancelled/)
    expect(decisionMessage(row, 'approve')).toBe('The run carries on. Nothing is sent again; the agent is told you checked it.')
  })
})