import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ apiGet: vi.fn(), addGrant: vi.fn() }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<any>('@/lib/api')
  return { ...actual, apiGet: api.apiGet }
})
vi.mock('@/lib/connections-api', () => ({ connectionsApi: { addGrant: api.addGrant } }))
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => ({ enabled: false, isLoading: false }) }))

import { AccessCard } from '../access-card'

/**
 * A Slack message from someone other than the agent's owner runs with the
 * agent's own access. The agent page says what it was not given yet, and
 * gives it, inline, one click per account (no dialog).
 */
const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AccessCard agentId="a-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  )

describe("the agent's Access card", () => {
  beforeEach(() => {
    api.apiGet.mockReset()
    api.addGrant.mockReset()
  })

  it('lists the accounts it was not given, and gives one on its click', async () => {
    const user = userEvent.setup()
    api.apiGet
      .mockResolvedValueOnce([{ kind: 'connection', id: 'c-hub', name: 'HubSpot private app', neededFor: 'The key for HubSpot Companies', scope: 'organization', canGrant: true }])
      .mockResolvedValueOnce([])
    api.addGrant.mockResolvedValue({ id: 'g-1' })
    renderCard()

    expect(screen.getByTestId('agent-access-card')).toHaveTextContent('When someone other than you writes to it on a channel')
    expect(await screen.findByText('It has not been given these yet:')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Let this agent use HubSpot private app' }))
    expect(api.addGrant).toHaveBeenCalledWith('c-hub', { principalType: 'agent', principalId: 'a-1' })
    expect(await screen.findByText('It has been given every account its tools and settings use.')).toBeInTheDocument()
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledTimes(2))
  })
})
