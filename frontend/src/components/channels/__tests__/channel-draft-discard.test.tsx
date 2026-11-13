/**
 * Picking a kind of channel on Add channel adds it at once and opens its
 * page. Backing out of that page with nothing saved left a draft behind
 * ("Telegram · Not answering yet") that nobody meant to keep; now it goes
 * again when the page closes. Anything saved, published or built keeps it,
 * and so does a channel opened from the list rather than just added.
 *
 * Also here: the Telegram page says where its key comes from (BotFather).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

import { ChannelSettings } from '../channel-settings'
import type { AgentChannel, EffectiveSettings } from '@/lib/agent-channels'
import type { Agent } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  gatewaysApi: { getById: vi.fn().mockResolvedValue(null), update: vi.fn(), getCustomDomain: vi.fn().mockResolvedValue(null) },
  getApiBaseUrl: () => 'https://api.test',
}))
vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
    connectionsApi: { list: vi.fn().mockResolvedValue([]), connect: vi.fn(), complete: vi.fn(), validate: vi.fn(), rotate: vi.fn(), remove: vi.fn() },
  }
})
vi.mock('@/lib/agent-channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-channels')>('@/lib/agent-channels')
  return {
    ...actual,
    agentChannelsApi: {
      check: vi.fn().mockResolvedValue({ ok: true, refusals: [] }),
      update: vi.fn(),
      publish: vi.fn(),
      unpublish: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
    },
  }
})
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlements: () => ({ has: () => false }) }))
vi.mock('@/hooks/use-organization-role', () => ({ useOrganizationRole: () => ({ role: 'admin', canManage: true, isOwner: false }) }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-1', slug: 'acme', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))

import { agentChannelsApi } from '@/lib/agent-channels'

const inherited: EffectiveSettings = {
  branding: { appName: 'Acme help', primaryColor: '#0f766e', greeting: 'Hi', theme: 'auto', suggestedPrompts: [], aiDisclosure: null, whiteLabel: false },
  visitorRules: {
    authMode: 'public_link',
    limits: { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120 },
    privacy: { retentionDays: null, visitorCanDelete: true, visitorCanExport: true, visitorMemory: false },
    caps: { dailyCents: 500, monthlyCents: 5000 },
    ownSpend: false,
  },
}
const agent = { id: 'agent-1', name: 'Support' } as Agent
const telegram = (over: Partial<AgentChannel> = {}): AgentChannel =>
  ({
    id: 'c-tg',
    agentId: 'agent-1',
    type: 'telegram',
    status: 'draft',
    name: 'Telegram',
    slug: null,
    gatewayId: null,
    endpoint: '/channels/c-tg',
    configuration: {},
    branding: null,
    visitorRules: null,
    disclosureRemovable: false,
    effective: inherited,
    ...over,
  }) as AgentChannel

/** A way off the channel page, as the page's own Back link would go. */
function Away() {
  return <p>Channels list</p>
}
function LeaveButton() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate('/agents/agent-1/channels')}>
      Leave
    </button>
  )
}

function openPage(channel: AgentChannel, state: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: `/agents/agent-1/channels/${channel.id}`, state }]}>
        <Routes>
          <Route
            path="/agents/agent-1/channels/:channelId"
            element={
              <>
                <LeaveButton />
                <ChannelSettings agent={agent} channel={channel} inherited={inherited} />
              </>
            }
          />
          <Route path="/agents/agent-1/channels" element={<Away />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const justAdded = (...ids: string[]) => ({ justAdded: { ids } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agentChannelsApi.check).mockResolvedValue({ ok: true, refusals: [] } as any)
  vi.mocked(agentChannelsApi.remove).mockResolvedValue(undefined as any)
})

describe('a channel added a moment ago', () => {
  it('is deleted again when its page is left with nothing saved', async () => {
    openPage(telegram(), justAdded('c-tg'))
    await screen.findByRole('heading', { name: 'Telegram', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(await screen.findByText('Channels list')).toBeInTheDocument()
    await waitFor(() => expect(agentChannelsApi.remove).toHaveBeenCalledWith('agent-1', 'c-tg'))
  })

  it('takes the web chat added for a desktop app with it', async () => {
    openPage(telegram({ id: 'c-desk', type: 'desktop', name: 'Desktop app' }), justAdded('c-desk', 'c-web'))
    await screen.findByRole('heading', { name: 'Desktop app', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(agentChannelsApi.remove).toHaveBeenCalledTimes(2))
    expect(agentChannelsApi.remove).toHaveBeenCalledWith('agent-1', 'c-desk')
    expect(agentChannelsApi.remove).toHaveBeenCalledWith('agent-1', 'c-web')
  })

  it('stays once something on its page is saved', async () => {
    vi.mocked(agentChannelsApi.update).mockImplementation(async (_a, _c, body: any) => telegram({ name: body.name ?? 'Telegram' }))
    openPage(telegram(), justAdded('c-tg'))
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Telegram for sales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(agentChannelsApi.update).toHaveBeenCalled())
    await screen.findByRole('heading', { name: 'Telegram for sales', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(await screen.findByText('Channels list')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(agentChannelsApi.remove).not.toHaveBeenCalled()
  })

  it('a channel opened from the list is never deleted for being left', async () => {
    openPage(telegram(), null)
    await screen.findByRole('heading', { name: 'Telegram', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(await screen.findByText('Channels list')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(agentChannelsApi.remove).not.toHaveBeenCalled()
  })

  it('a published one is never deleted for being left', async () => {
    openPage(telegram({ status: 'live' }), justAdded('c-tg'))
    await screen.findByRole('heading', { name: 'Telegram', level: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(await screen.findByText('Channels list')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(agentChannelsApi.remove).not.toHaveBeenCalled()
  })
})

describe('the Telegram page', () => {
  it('says the token comes from BotFather, with a link to it', async () => {
    openPage(telegram(), null)
    const link = await screen.findByRole('link', { name: '@BotFather' })
    expect(link).toHaveAttribute('href', 'https://t.me/botfather')
    expect(screen.getByText(/send \/newbot/)).toBeInTheDocument()
  })
})
