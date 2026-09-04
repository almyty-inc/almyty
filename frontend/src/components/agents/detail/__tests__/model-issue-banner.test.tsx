import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ModelIssueBanner } from '../model-issue-banner'
import type { Agent } from '@/types'

const issue = {
  code: 'MODEL_NOT_FOUND' as const,
  model: 'claude-sonnet-4-20250514',
  providerId: 'p1',
  message: 'Model "claude-sonnet-4-20250514" is not available from this provider (model: claude-sonnet-4-20250514).',
  detectedAt: '2026-09-04T09:10:00.000Z',
}

const agent = (overrides: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'x', mode: 'workflow', settings: {}, ...overrides }) as unknown as Agent

const renderIt = (a: Agent) => render(<MemoryRouter><ModelIssueBanner agent={a} /></MemoryRouter>)

describe('ModelIssueBanner', () => {
  it('renders nothing when the agent has no model issue', () => {
    renderIt(agent())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the retired model, links the provider, and says where to fix it', () => {
    renderIt(agent({ settings: { modelIssue: issue } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('claude-sonnet-4-20250514')
    expect(alert).toHaveTextContent('no longer available')
    expect(alert).toHaveTextContent('LLM node')
    expect(screen.getByRole('link', { name: 'provider' })).toHaveAttribute('href', '/llm-providers/p1')
    expect(alert).not.toHaveTextContent('schedule')
  })

  it('explains the paused schedule when the backend paused it for this reason', () => {
    renderIt(
      agent({
        mode: 'autonomous',
        settings: {
          modelIssue: issue,
          schedule: { enabled: false, intervalMinutes: 10, input: {}, pausedReason: issue },
        },
      }),
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('schedule was paused')
    expect(alert).toHaveTextContent('enable the schedule again')
    expect(alert).toHaveTextContent('agent configuration')
  })
})
