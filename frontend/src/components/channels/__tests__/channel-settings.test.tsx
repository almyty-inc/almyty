import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ChannelSettings } from '../channel-settings'
import { formFromEffective, overridesFromForm, settingsFromForm } from '../public-settings-fields'
import type { AgentChannel, EffectiveSettings } from '@/lib/agent-channels'
import type { Agent } from '@/types'

vi.mock('@/lib/api', () => ({
  gatewaysApi: { getById: vi.fn().mockResolvedValue(null) },
  credentialsApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'cred-slack', name: 'Our Slack app', connectorKey: 'channel-slack' },
      { id: 'cred-other-channel', name: 'Another channel keys', connectorKey: 'channel-slack', metadata: { managedBy: { kind: 'agent_channel', id: 'x' } } },
      { id: 'cred-openai', name: 'OpenAI', connectorKey: 'openai' },
    ]),
  },
  getApiBaseUrl: () => 'https://api.test',
}))
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
vi.mock('@/store/organization', () => ({ useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', slug: 'acme' } }) }))

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
    slug: null,
    gatewayId: null,
    endpoint: '/channels/c-slack',
    configuration: { client_id: '123.456' },
    branding: null,
    visitorRules: null,
    effective: inherited,
    ...over,
  }) as AgentChannel

beforeEach(() => {
  vi.mocked(agentChannelsApi.update).mockReset()
  vi.mocked(agentChannelsApi.update).mockImplementation(async (_a, _c, body: any) => slack({ configuration: body.configuration ?? {} }))
})

describe('a channel page', () => {
  it('saves only the keys that changed, and never sends a stored secret back', async () => {
    render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
    fireEvent.change(await screen.findByLabelText(/Signing secret/), { target: { value: 'sign-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(agentChannelsApi.update).toHaveBeenCalledWith('agent-1', 'c-slack', { configuration: { signing_secret: 'sign-1' } }),
    )
  })

  it("offers the org's credentials for this platform, and none another channel made for itself", async () => {
    render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
    fireEvent.click(await screen.findByRole('combobox', { name: 'Keys' }))
    expect(await screen.findByRole('option', { name: 'Our Slack app' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Another channel keys' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'OpenAI' })).toBeNull()
  })

  it('takes the keys from a picked credential instead of the fields', async () => {
    render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
    fireEvent.click(await screen.findByRole('combobox', { name: 'Keys' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Our Slack app' }))
    expect(screen.queryByLabelText(/Signing secret/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(agentChannelsApi.update).toHaveBeenCalledWith('agent-1', 'c-slack', { credentialId: 'cred-slack' }))
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

  it('says "Delete Slack?" before deleting it', async () => {
    render(<ChannelSettings agent={agent} channel={slack()} inherited={inherited} />)
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }))
    expect(await screen.findByText('Delete Slack?')).toBeInTheDocument()
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
