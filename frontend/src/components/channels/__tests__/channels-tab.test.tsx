import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../test/setup'
import { ChannelsTab } from '../channels-tab'
import type { AgentChannel, PublicSettings } from '@/lib/agent-channels'

vi.mock('@/lib/api', () => ({
  gatewaysApi: { getAll: vi.fn() },
  getApiBaseUrl: () => 'https://api.test',
}))
vi.mock('@/lib/agent-channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-channels')>('@/lib/agent-channels')
  return { ...actual, agentChannelsApi: { list: vi.fn(), publicSettings: vi.fn() } }
})
// The signed-in person's role; an admin unless a test says otherwise.
const role = vi.hoisted(() => ({ canManage: true }))
vi.mock('@/hooks/use-organization-role', () => ({
  useOrganizationRole: () => ({ role: role.canManage ? 'admin' : 'member', canManage: role.canManage, isOwner: false }),
}))

import { gatewaysApi } from '@/lib/api'
import { agentChannelsApi } from '@/lib/agent-channels'

const effective = {
  branding: { appName: 'Acme help' },
  visitorRules: {
    authMode: 'public_link',
    limits: {},
    privacy: { retentionDays: null, visitorCanDelete: true, visitorCanExport: true, visitorMemory: false },
    caps: { dailyCents: 500, monthlyCents: 5000 },
    ownSpend: false,
  },
} as PublicSettings['effective']

const channel = (over: Partial<AgentChannel>): AgentChannel =>
  ({
    id: 'c-1',
    agentId: 'agent-1',
    type: 'web',
    status: 'draft',
    slug: null,
    gatewayId: null,
    endpoint: '/channels/c-1',
    branding: null,
    visitorRules: null,
    effective,
    ...over,
  }) as AgentChannel

beforeEach(() => {
  role.canManage = true
  vi.mocked(gatewaysApi.getAll).mockResolvedValue({ gateways: [] } as any)
  vi.mocked(agentChannelsApi.publicSettings).mockResolvedValue({ branding: null, visitorRules: null, effective })
})

/**
 * The agent's Channels tab is the one place its channels are listed,
 * added and opened: a table whose rows open each channel's page, one
 * "Add channel", and the branding and visitor rules they inherit.
 */
describe('ChannelsTab', () => {
  it("lists the agent's channels in a table, each row opening the channel", async () => {
    vi.mocked(agentChannelsApi.list).mockResolvedValue([
      channel({ id: 'c-web', type: 'web', slug: 'acme-help', status: 'live' }),
      channel({ id: 'c-slack', type: 'slack', status: 'draft', branding: { greeting: 'Hi' } }),
      channel({ id: 'c-desk', type: 'desktop', status: 'built', lastBuild: { version: '1.2.0' } }),
    ])
    render(<ChannelsTab agentId="agent-1" agentName="Support" />)

    await screen.findByText('Desktop app')
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Web chat.*acme-help\..*Same as Support.*Live$/),
      expect.stringMatching(/^Slack.*Not answering yet.*Its own.*Draft$/),
      expect.stringMatching(/^Desktop app.*Last build 1\.2\.0.*Same as Support.*Built$/),
    ])
    expect(agentChannelsApi.list).toHaveBeenCalledWith('agent-1')
  })

  it('tells two channels of one kind apart by their names, with the kind beside a name of its own', async () => {
    vi.mocked(agentChannelsApi.list).mockResolvedValue([
      channel({ id: 'c-s1', type: 'slack', name: 'Slack' }),
      channel({ id: 'c-s2', type: 'slack', name: 'Slack for sales' }),
    ])
    render(<ChannelsTab agentId="agent-1" agentName="Support" />)
    await screen.findByText('Slack for sales')
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^Slack(?!Slack)/), expect.stringMatching(/^Slack for salesSlack/)])
  })

  it('offers one "Add channel", and the branding and visitor rules every channel uses', async () => {
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    render(<ChannelsTab agentId="agent-1" agentName="Support" />)

    expect(await screen.findByText('No channels yet')).toBeInTheDocument()
    const adds = screen.getAllByRole('link', { name: 'Add channel' })
    expect(adds.every((a) => a.getAttribute('href') === '/agents/agent-1/channels/new')).toBe(true)
    const summary = await screen.findByTestId('public-settings-summary')
    expect(summary).toHaveTextContent('Acme help')
    expect(summary).toHaveTextContent('anyone with the link')
    expect(within(summary).getByRole('link', { name: /Branding and visitor rules/ })).toHaveAttribute(
      'href',
      '/agents/agent-1/channels/settings',
    )
  })

  it('offers owners and admins the visitor data page, and nobody else', async () => {
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    render(<ChannelsTab agentId="agent-1" agentName="Support" />)
    const summary = await screen.findByTestId('public-settings-summary')
    expect(within(summary).getByRole('link', { name: /Visitor data/ })).toHaveAttribute('href', '/agents/agent-1/channels/visitor-data')
  })

  it('does not offer a member the visitor data page the server would refuse them', async () => {
    role.canManage = false
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    render(<ChannelsTab agentId="agent-1" agentName="Support" />)
    const summary = await screen.findByTestId('public-settings-summary')
    expect(within(summary).queryByRole('link', { name: /Visitor data/ })).toBeNull()
    expect(within(summary).getByRole('link', { name: /Branding and visitor rules/ })).toBeInTheDocument()
  })

  it('lists channels only: every gateway that serves an agent is one of its channels', async () => {
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    render(<ChannelsTab agentId="agent-1" />)

    expect(await screen.findByText('No channels yet')).toBeInTheDocument()
    expect(screen.queryByText(/Also served by gateways/)).toBeNull()
    expect(gatewaysApi.getAll).not.toHaveBeenCalled()
  })

  it('never says "app", "place" or "distribution" to the user', () => {
    const source = readFileSync(join(__dirname, '..', 'channels-tab.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(source).not.toMatch(/['">][^'"<]*\b(places?|distributions?|apps?)\b/i)
  })
})
