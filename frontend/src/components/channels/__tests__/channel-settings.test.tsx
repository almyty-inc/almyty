import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../test/setup'
import { ChannelSettings, missingKeysLine } from '../channel-settings'
import { advancedSummary, formFromEffective, overridesFromForm, settingsFromForm } from '../public-settings-fields'
import type { AgentChannel, EffectiveSettings } from '@/lib/agent-channels'
import type { Agent } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    getCustomDomain: vi.fn().mockResolvedValue(null),
    setCustomDomain: vi.fn(),
    removeCustomDomain: vi.fn(),
    verifyCustomDomain: vi.fn(),
    getVisitorOAuth: vi.fn(),
    setVisitorOAuth: vi.fn(),
  },
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
import { gatewaysApi } from '@/lib/api'

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
  vi.clearAllMocks()
  vi.mocked(agentChannelsApi.check).mockResolvedValue({ ok: true, refusals: [] } as any)
  vi.mocked(gatewaysApi.getById).mockResolvedValue(null)
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

    it('is said once, in the Live section, not again under branding', async () => {
      render(<ChannelSettings agent={agent} channel={web()} inherited={inherited} />)
      await screen.findByLabelText(/^Address/)
      expect(screen.getAllByText(/People open it at/)).toHaveLength(1)
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

  describe('keys a messaging channel still needs', () => {
    const missing = { ok: false, refusals: [{ code: 'MISSING_CREDENTIALS', message: 'This platform still needs its keys before it can go live: bot_token, signing_secret' }] }

    it('are not an error on first view', async () => {
      vi.mocked(agentChannelsApi.check).mockResolvedValue(missing as any)
      render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
      await screen.findByRole('button', { name: 'Publish' })
      await waitFor(() => expect(agentChannelsApi.check).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.queryByText(/Pick or create/)).toBeNull()
      expect(screen.queryByText(/bot_token|signing_secret|still needs its keys/)).toBeNull()
    })

    it('are said in plain words when publishing is tried, and nothing is published', async () => {
      vi.mocked(agentChannelsApi.check).mockResolvedValue(missing as any)
      render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
      const publish = await screen.findByRole('button', { name: 'Publish' })
      await waitFor(() => expect(agentChannelsApi.check).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 0))
      fireEvent.click(publish)
      expect((await screen.findAllByText('Pick or create the Slack app credential first.')).length).toBeGreaterThan(0)
      expect(screen.queryByText(/bot_token|signing_secret/)).toBeNull()
      expect(agentChannelsApi.publish).not.toHaveBeenCalled()
    })

    it('name the platform for the others', () => {
      expect(missingKeysLine('telegram')).toBe('Pick or create the Telegram credential first.')
    })
  })

  describe('the web chat and the widget', () => {
    beforeEach(() => {
      if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
      if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
    })

    it('save the domain and the allowed sites with the page, under its one Save', async () => {
      vi.mocked(gatewaysApi.getById).mockResolvedValue({
        id: 'gw-web',
        type: 'hosted_chat',
        configuration: { hostedChat: { theme: 'dark' }, allowedOrigins: ['https://shop.example.com'] },
      })
      vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(null)
      vi.mocked(gatewaysApi.setCustomDomain).mockResolvedValue(null)
      vi.mocked(gatewaysApi.update).mockResolvedValue({})
      render(<ChannelSettings agent={agent} channel={web({ status: 'live', gatewayId: 'gw-web' })} inherited={inherited} />)

      fireEvent.change(await screen.findByLabelText('Domain'), { target: { value: 'chat.acme.com' } })
      fireEvent.change(await screen.findByLabelText('Add a site'), { target: { value: 'https://blog.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(screen.getAllByRole('button', { name: /save/i }).map((b) => b.textContent)).toEqual(['Save'])

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(gatewaysApi.setCustomDomain).toHaveBeenCalledWith('gw-web', 'chat.acme.com'))
      expect(gatewaysApi.update).toHaveBeenCalledWith('gw-web', {
        configuration: { hostedChat: { theme: 'dark' }, allowedOrigins: ['https://shop.example.com', 'https://blog.example.com'] },
      })
      expect(agentChannelsApi.update).not.toHaveBeenCalled()
    })

    it('say a refused domain next to the domain', async () => {
      vi.mocked(gatewaysApi.getById).mockResolvedValue({ id: 'gw-web', type: 'hosted_chat', configuration: {} })
      vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(null)
      vi.mocked(gatewaysApi.setCustomDomain).mockRejectedValue({ response: { data: { message: 'Another surface is already serving that domain.' } } })
      render(<ChannelSettings agent={agent} channel={web({ status: 'live', gatewayId: 'gw-web' })} inherited={inherited} />)
      fireEvent.change(await screen.findByLabelText('Domain'), { target: { value: 'chat.taken.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(await screen.findByText('Another surface is already serving that domain.')).toBeInTheDocument()
    })

    it("save where the widget sits with the page, merged into the gateway's configuration", async () => {
      vi.mocked(gatewaysApi.getById).mockResolvedValue({
        id: 'gw-widget',
        type: 'chat_widget',
        configuration: { appId: 'app-1', widget: { position: 'bottom-right', launcherIcon: 'help', title: 'Old' } },
      })
      vi.mocked(gatewaysApi.update).mockResolvedValue({})
      render(
        <ChannelSettings
          agent={agent}
          channel={web({ id: 'c-widget', type: 'widget', name: 'Website widget', slug: null, status: 'live', gatewayId: 'gw-widget' })}
          inherited={inherited}
        />,
      )
      const user = userEvent.setup()
      await user.click(await screen.findByLabelText('Position'))
      await user.click(await screen.findByRole('option', { name: 'Bottom left' }))
      expect(screen.getAllByRole('button', { name: /save/i }).map((b) => b.textContent)).toEqual(['Save'])
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(gatewaysApi.update).toHaveBeenCalledWith('gw-widget', {
          configuration: { appId: 'app-1', allowedOrigins: [], widget: { title: 'Old', position: 'bottom-left', launcherIcon: 'help' } },
        }),
      )
    })
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

  it('sums up the spend limits as money', () => {
    expect(advancedSummary(formFromEffective(inherited))).toMatch(/^\$0\.50 per run · \$5 a day, \$50 a month · /)
  })

  it("keeps a channel following its agent on every field it does not change", () => {
    const form = { ...formFromEffective(inherited), authMode: 'sso' as const, perIp: '10' }
    expect(overridesFromForm(form, inherited)).toEqual({
      branding: null,
      visitorRules: { authMode: 'sso', limits: { perIpRateLimit: 10 } },
    })
  })
})
