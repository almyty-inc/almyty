import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ChannelSettings } from '../channel-settings'
import { formFromEffective, overridesFromForm, settingsFromForm } from '../public-settings-fields'
import type { AgentChannel, EffectiveSettings } from '@/lib/agent-channels'
import type { Agent } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  gatewaysApi: { getById: vi.fn().mockResolvedValue(null) },
  getApiBaseUrl: () => 'https://api.test',
}))
// Every key is a credential on Credentials, listed by the shared picker.
vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
    connectionsApi: {
      list: vi.fn().mockResolvedValue([
        { id: 'cred-slack-app', name: 'Our Slack app', connectorKey: 'channel-slack-app', connectorDisplayName: 'Slack app (Add to Slack)', kind: 'channel', owner: 'org', health: { status: 'valid' }, createdAt: '' },
        { id: 'cred-slack-bot', name: 'One workspace bot', connectorKey: 'channel-slack', connectorDisplayName: 'Slack', kind: 'channel', owner: 'org', health: { status: 'valid' }, createdAt: '' },
        { id: 'cred-telegram', name: 'Telegram bot', connectorKey: 'channel-telegram', connectorDisplayName: 'Telegram', kind: 'channel', owner: 'org', health: { status: 'valid' }, createdAt: '' },
        { id: 'cred-openai', name: 'OpenAI', connectorKey: 'openai', connectorDisplayName: 'OpenAI', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '' },
      ]),
      connect: vi.fn(),
      complete: vi.fn(),
      validate: vi.fn(),
      rotate: vi.fn(),
      remove: vi.fn(),
    },
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
      remove: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
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
const slack = (over: Partial<AgentChannel> = {}): AgentChannel =>
  ({
    id: 'c-slack',
    agentId: 'agent-1',
    type: 'slack',
    status: 'draft',
    name: 'Slack',
    slug: null,
    gatewayId: null,
    endpoint: '/channels/c-slack',
    configuration: { client_id: '123.456' },
    branding: null,
    visitorRules: null,
    disclosureRemovable: false,
    effective: inherited,
    ...over,
  }) as AgentChannel
const web = (over: Partial<AgentChannel> = {}): AgentChannel =>
  slack({ id: 'c-web', type: 'web', name: 'Web chat', slug: 'support', endpoint: '/channels/c-web', configuration: {}, ...over })

beforeEach(() => {
  vi.mocked(agentChannelsApi.update).mockReset()
  vi.mocked(agentChannelsApi.update).mockImplementation(async (_a, _c, body: any) =>
    slack({ name: body.name ?? 'Slack', slug: body.slug ?? null, configuration: body.configuration ?? {} }),
  )
})

describe('a channel page', () => {
  it('is titled by its name, and saves a new one', async () => {
    render(<ChannelSettings agent={agent} channel={slack({ name: 'Slack for sales' })} inherited={inherited} />)
    expect(await screen.findByRole('heading', { name: 'Slack for sales', level: 1 })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Slack for support' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(agentChannelsApi.update).toHaveBeenCalledWith('agent-1', 'c-slack', { name: 'Slack for support' }))
  })

  it('says a taken name next to the name, not in a toast', async () => {
    vi.mocked(agentChannelsApi.update).mockRejectedValue({ response: { data: { message: 'Support already has a channel called Telegram. Pick another name.' } } })
    render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Telegram' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Support already has a channel called Telegram. Pick another name.')).toBeInTheDocument()
  })

  it("takes its keys only from Credentials: the platform's own credentials, picked or created here, and no key field", async () => {
    render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
    const picker = await screen.findByRole('combobox', { name: /Slack app/ })
    await waitFor(() => expect(picker).toBeEnabled())
    fireEvent.click(picker)
    expect(await screen.findByRole('option', { name: /Our Slack app/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Telegram bot/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /OpenAI/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /Our Slack app/ }))
    expect(screen.getAllByRole('button', { name: 'Create one here' }).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText(/Signing secret|Client secret|Bot token/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(agentChannelsApi.update).toHaveBeenCalledWith('agent-1', 'c-slack', { credentialId: 'cred-slack-app' }))
  })


  it("stores only what differs from the agent's branding and visitor rules", async () => {
    render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
    fireEvent.click(await screen.findByRole('switch', { name: /Use this channel.s own/ }))
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Hello from Slack' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(agentChannelsApi.update).toHaveBeenCalledWith('agent-1', 'c-slack', {
        branding: { greeting: 'Hello from Slack' },
        visitorRules: null,
      }),
    )
  })

  it('says that deleting it deletes the gateway it answers on', async () => {
    render(<ChannelSettings agent={agent} channel={slack({ gatewayId: 'gw-1', status: 'live' })} inherited={inherited} />)
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }))
    expect(await screen.findByText('Delete Slack?')).toBeInTheDocument()
    expect(screen.getByText(/the gateway it answers on is deleted/)).toBeInTheDocument()
  })

  describe('the AI disclosure switch', () => {
    it('is on by default and shows the line people get', async () => {
      render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
      const toggle = await screen.findByRole('switch', { name: 'Tell people they are talking to an AI' })
      expect(toggle).toBeChecked()
      expect(screen.getByText(/You are chatting with an AI assistant\./)).toBeInTheDocument()
    })

    it('cannot be turned off without the white-label entitlement, and says why', async () => {
      render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
      expect(await screen.findByRole('switch', { name: 'Tell people they are talking to an AI' })).toBeDisabled()
      expect(screen.getByText('Turning it off needs the white-label entitlement.')).toBeInTheDocument()
    })

    it('saves off when the organization may turn it off', async () => {
      render(<ChannelSettings agent={agent} channel={slack({ disclosureRemovable: true })} inherited={inherited} />)
      fireEvent.click(await screen.findByRole('switch', { name: 'Tell people they are talking to an AI' }))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(agentChannelsApi.update).toHaveBeenCalledWith('agent-1', 'c-slack', { configuration: { aiDisclosure: false } }))
    })

    it('is not on a channel no person talks to', async () => {
      render(<ChannelSettings agent={agent} channel={slack({ type: 'a2a', name: 'Other agents (A2A)', configuration: {} })} inherited={inherited} />)
      await screen.findByRole('heading', { name: 'Other agents (A2A)', level: 1 })
      expect(screen.queryByRole('switch', { name: 'Tell people they are talking to an AI' })).toBeNull()
    })
  })

  describe("the web chat's address", () => {
    it('is generated, and the owner can change it', async () => {
      render(<ChannelSettings agent={agent} channel={web()} inherited={inherited} />)
      const address = await screen.findByLabelText(/^Address/)
      expect(address).toHaveValue('support')
      fireEvent.change(address, { target: { value: 'Acme-Help' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(agentChannelsApi.update).toHaveBeenCalledWith('agent-1', 'c-web', { slug: 'acme-help' }))
    })

    it('refuses an unusable one before asking the server', async () => {
      render(<ChannelSettings agent={agent} channel={web()} inherited={inherited} />)
      fireEvent.change(await screen.findByLabelText(/^Address/), { target: { value: '-bad-' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(await screen.findByText('Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.')).toBeInTheDocument()
      expect(agentChannelsApi.update).not.toHaveBeenCalled()
    })

    it('says plainly when another web chat has it', async () => {
      vi.mocked(agentChannelsApi.update).mockRejectedValue({ response: { data: { message: 'acme-help is already taken as a web chat address. Pick another.' } } })
      render(<ChannelSettings agent={agent} channel={web()} inherited={inherited} />)
      fireEvent.change(await screen.findByLabelText(/^Address/), { target: { value: 'acme-help' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(await screen.findByText('acme-help is already taken as a web chat address. Pick another.')).toBeInTheDocument()
    })
  })
})

describe('the settings form', () => {
  it('round-trips what it shows', () => {
    const form = formFromEffective(inherited)
    expect(settingsFromForm(form).visitorRules).toMatchObject({
      authMode: 'public_link',
      limits: { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120, dailySpendCapCents: 500, monthlySpendCapCents: 5000 },
    })
    expect(overridesFromForm(form, inherited)).toEqual({ branding: null, visitorRules: null })
  })

  it("keeps a channel following its agent on every field it does not change", () => {
    const form = { ...formFromEffective(inherited), authMode: 'sso' as const, perIp: '10' }
    expect(overridesFromForm(form, inherited)).toEqual({
      branding: null,
      visitorRules: { authMode: 'sso', limits: { perIpRateLimit: 10 } },
    })
  })
})
