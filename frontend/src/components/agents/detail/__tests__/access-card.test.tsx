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
    // Said as being about other people: the owner's own runs use the owner's accounts anyway.
    expect(screen.getByTestId('agent-access-card')).toHaveTextContent('Your own runs always use your accounts')
    expect(screen.getByTestId('agent-access-card')).toHaveTextContent('when someone else writes to it on a channel')
    expect(await screen.findByText("Not yet given for other people's messages (your own runs still use them):")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Let this agent use HubSpot private app' }))
    expect(api.addGrant).toHaveBeenCalledWith('c-hub', { principalType: 'agent', principalId: 'a-1' })
    expect(await screen.findByText("Other people's messages can use every account its tools and settings use.")).toBeInTheDocument()
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledTimes(2))
  })

  // A team-scoped key never serves a channel open to everyone (the access
  // model: a team connection reaches only that team's gateways). The card
  // said nothing about it, so the refusal looked like a bug.
  it('says a team connection works only on the team channels, and offers no grant for it', async () => {
    api.apiGet.mockResolvedValueOnce([
      {
        kind: 'connection', id: 'c-stripe', name: 'Stripe restricted key', neededFor: 'The key for Stripe', scope: 'team', canGrant: false,
        note: "This is the team's own connection: it works for the team's members and on channels set up for that team, never on a channel open to everyone or for the agent acting as itself, and a grant cannot change that.",
      },
    ])
    renderCard()
    expect(screen.getByTestId('access-card-team-rule')).toHaveTextContent('not on a channel open to everyone')
    expect(await screen.findByText(/never on a channel open to everyone/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Let this agent use Stripe/ })).not.toBeInTheDocument()
  })
})
