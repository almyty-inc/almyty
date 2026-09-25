import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { AppDistributionPage } from '../app-distribution'
import { agentAppsApi, type AgentApp, type AppDistribution } from '@/lib/agent-apps'
import { gatewaysApi } from '@/lib/api'

/**
 * The app's own pages are the one place an agent is put in front of
 * people. The web app: publish, and the link is there; who can use it,
 * your own domain, sign-in and allowed sites on the same page, from the
 * cards the gateway page used to carry. Slack: "Add to Slack" first.
 */
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return {
    ...actual,
    agentAppsApi: {
      getById: vi.fn(),
      update: vi.fn(),
      addDistribution: vi.fn(),
      removeDistribution: vi.fn(),
      checkDistribution: vi.fn(),
      publishDistribution: vi.fn(),
      unpublishDistribution: vi.fn(),
    },
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getApiBaseUrl: () => 'https://api.example.com',
    agentsApi: {
      getAll: vi.fn().mockResolvedValue([
        { id: 'triage-1', name: 'Triage' },
        { id: 'billing-2', name: 'Billing' },
      ]),
    },
    gatewaysApi: {
      getById: vi.fn(),
      update: vi.fn(),
      getCustomDomain: vi.fn(),
      getVisitorOAuth: vi.fn(),
      getHostedChatSso: vi.fn(),
      getInstallations: vi.fn(),
    },
  }
})

vi.mock('@/lib/tenant-host', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tenant-host')>('@/lib/tenant-host')
  return { ...actual, hostedChatBaseDomain: () => 'almyty.app' }
})

vi.mock('@/hooks/use-entitlement', () => ({ useEntitlements: () => ({ has: () => false }) }))

vi.mock('@/store/organization', () => {
  const ORG = { id: 'org-1', name: 'Acme Inc', slug: 'acme' }
  const useOrganizationStore: any = () => ({ currentOrganization: ORG })
  useOrganizationStore.getState = () => ({ currentOrganization: ORG })
  return { useOrganizationStore }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

const api = agentAppsApi as unknown as Record<string, ReturnType<typeof vi.fn>>
const gw = gatewaysApi as unknown as Record<string, ReturnType<typeof vi.fn>>

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/apps/:slug/distributions/:target', element: <AppDistributionPage /> }],
    { initialEntries: [path] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const place = (over: Partial<AppDistribution>): AppDistribution =>
  ({ id: 'd-web', appId: 'app-1', target: 'web', status: 'draft', gatewayId: null, configuration: {}, ...over }) as AppDistribution

const app = (over: Partial<AgentApp> = {}, distributions: AppDistribution[] = [place({})]): AgentApp =>
  ({
    id: 'app-1',
    slug: 'support',
    name: 'Acme Support',
    description: null,
    agentIds: ['triage-1'],
    branding: { appName: 'Acme Support' },
    authMode: 'public_link',
    capabilities: {},
    limits: {},
    privacy: null,
    isActive: true,
    distributions,
    ...over,
  }) as AgentApp

beforeEach(() => {
  vi.clearAllMocks()
  api.getById.mockResolvedValue(app())
  api.checkDistribution.mockResolvedValue({ ok: true, refusals: [] })
  api.addDistribution.mockResolvedValue({})
  api.publishDistribution.mockResolvedValue({})
  api.update.mockResolvedValue({})
  gw.getById.mockResolvedValue({ id: 'gw-web', type: 'hosted_chat', configuration: { allowedOrigins: ['https://www.acme.com'] } })
  gw.getCustomDomain.mockResolvedValue(null)
  gw.getVisitorOAuth.mockResolvedValue({ provider: null, redirectUris: ['https://support.almyty.app/api/public/chat/support/auth/oauth/callback'] })
  gw.getInstallations.mockResolvedValue([])
})

describe('the web app page', () => {
  it('shows the link right after publishing', async () => {
    renderAt('/apps/support/distributions/web')
    expect(await screen.findByTestId('web-address-pending')).toHaveTextContent('https://support.almyty.app')
    expect(screen.queryByTestId('web-address')).toBeNull()

    api.getById.mockResolvedValue(app({}, [place({ status: 'live', gatewayId: 'gw-web' })]))
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

    await waitFor(() => expect(api.publishDistribution).toHaveBeenCalledWith('support', 'web'))
    const link = await screen.findByTestId('web-address')
    expect(link).toHaveTextContent('https://support.almyty.app')
    expect(screen.getByRole('link', { name: /Open it/ })).toHaveAttribute('href', 'https://support.almyty.app')
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeInTheDocument()
  })

  it('has no Save: every setting on it applies by itself', async () => {
    renderAt('/apps/support/distributions/web')
    await screen.findByTestId('web-address-pending')
    expect(screen.queryByTestId('form-page-footer')).toBeNull()
  })

  it('says where the domain and allowed sites go before it is published', async () => {
    renderAt('/apps/support/distributions/web')
    expect(await screen.findByTestId('web-settings-after-publish')).toBeInTheDocument()
    expect(gw.getCustomDomain).not.toHaveBeenCalled()
  })

  it('carries the custom domain and allowed sites cards once published, keyed by its gateway', async () => {
    api.getById.mockResolvedValue(app({}, [place({ status: 'live', gatewayId: 'gw-web' })]))
    renderAt('/apps/support/distributions/web')
    expect(await screen.findByText('Custom domain')).toBeInTheDocument()
    expect(await screen.findByText('Allowed sites')).toBeInTheDocument()
    expect(await screen.findByText('https://www.acme.com')).toBeInTheDocument()
    expect(gw.getCustomDomain).toHaveBeenCalledWith('gw-web')
    expect(gw.getById).toHaveBeenCalledWith('gw-web')
  })

  it('asks who can use it in one line, and saves a pick on the app', async () => {
    api.getById.mockResolvedValue(app({}, [place({ status: 'live', gatewayId: 'gw-web' })]))
    renderAt('/apps/support/distributions/web')
    const line = await screen.findByTestId('app-access')
    expect(line).toHaveTextContent('Who can use it: anyone with the link · Change')
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(screen.getByTestId('access-email_otp'))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('support', { authMode: 'email_otp' }))
  })

  it('shows the sign-in provider, presets first, when people sign in with OAuth', async () => {
    api.getById.mockResolvedValue(app({ authMode: 'oauth' }, [place({ status: 'live', gatewayId: 'gw-web' })]))
    renderAt('/apps/support/distributions/web')
    expect(await screen.findByText('Visitor sign-in provider')).toBeInTheDocument()
    expect(await screen.findByTestId('visitor-oauth-preset-google')).toBeInTheDocument()
    expect(gw.getVisitorOAuth).toHaveBeenCalledWith('gw-web')
    expect(screen.queryByLabelText('Issuer or discovery URL')).toBeNull()
  })

  it('applies "Answered by" as soon as it is picked', async () => {
    api.getById.mockResolvedValue(app({ agentIds: ['triage-1', 'billing-2'] }))
    renderAt('/apps/support/distributions/web')
    await screen.findByTestId('web-address-pending')
    fireEvent.click(await screen.findByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Billing' }))
    await waitFor(() => expect(api.addDistribution).toHaveBeenCalledWith('support', 'web', { agentId: 'billing-2' }))
  })
})

describe('the Slack page', () => {
  const slack = (over: Partial<AppDistribution> = {}) =>
    app({}, [place({ id: 'd-slack', target: 'slack', ...over })])

  it('leads with Add to Slack and keeps the bot token under Advanced', async () => {
    api.getById.mockResolvedValue(slack())
    renderAt('/apps/support/distributions/slack')
    expect(await screen.findByRole('heading', { name: 'Add to Slack' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Client ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Client secret/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Signing secret/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Bot token/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }))
    expect(screen.getByLabelText(/^Bot token/)).toBeInTheDocument()
  })

  it('does not ask for a bot token once the Slack app credentials are there', async () => {
    api.getById.mockResolvedValue(slack({ configuration: { client_id: '1.2', credentialKeys: ['client_secret', 'signing_secret'] } }))
    renderAt('/apps/support/distributions/slack')
    await screen.findByRole('heading', { name: 'Add to Slack' })
    expect(screen.queryByText('Needed before this can go live.')).toBeNull()
  })

  it('gives the install link and the redirect URL once live', async () => {
    api.getById.mockResolvedValue(slack({ status: 'live', gatewayId: 'gw-slack', configuration: { client_id: '1.2' } }))
    gw.getById.mockResolvedValue({ id: 'gw-slack', type: 'slack', configuration: { client_id: '1.2' } })
    renderAt('/apps/support/distributions/slack')
    expect(await screen.findByTestId('slack-install-url')).toHaveTextContent('https://api.example.com/gateways/gw-slack/install/slack')
    expect(screen.getByText('https://api.example.com/gateways/gw-slack/install/slack/callback')).toBeInTheDocument()
  })
})
