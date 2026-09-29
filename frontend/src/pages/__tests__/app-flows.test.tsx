import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

import { AppsPage } from '../apps'
import { AppNewPage } from '../app-new'
import { AppDetailPage } from '../app-detail'
import { AppDistributionNewPage } from '../app-distribution-new'
import { AppDistributionPage } from '../app-distribution'
import { AppSigningNewPage } from '../app-signing-new'
import { agentAppsApi, type AgentApp } from '@/lib/agent-apps'
import { agentsApi, credentialsApi } from '@/lib/api'

// These tests are about routes, so they need the real router rather than
// the stubs src/test/setup.tsx installs for every suite.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return {
    ...actual,
    agentAppsApi: {
      list: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      check: vi.fn(),
      addDistribution: vi.fn(),
      removeDistribution: vi.fn(),
      checkDistribution: vi.fn(),
      publishDistribution: vi.fn(),
      unpublishDistribution: vi.fn(),
      platforms: vi.fn(),
      builds: vi.fn(),
      capabilities: vi.fn(),
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
    credentialsApi: { getAll: vi.fn().mockResolvedValue({ data: [] }), create: vi.fn() },
  }
})

vi.mock('@/store/organization', () => {
  const ORG = { id: 'org-1', name: 'Acme Inc', slug: 'acme' }
  const useOrganizationStore: any = () => ({ currentOrganization: ORG })
  useOrganizationStore.getState = () => ({ currentOrganization: ORG })
  return { useOrganizationStore }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

const api = agentAppsApi as unknown as Record<string, ReturnType<typeof vi.fn>>

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname + location.search}</p>
}

const page = (el: React.ReactNode) => (
  <>
    {el}
    <Where />
  </>
)

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/apps', element: page(<AppsPage />) },
      { path: '/apps/new', element: page(<AppNewPage />) },
      { path: '/apps/:slug', element: page(<AppDetailPage />) },
      { path: '/apps/:slug/distributions/new', element: page(<AppDistributionNewPage />) },
      { path: '/apps/:slug/distributions/:target', element: page(<AppDistributionPage />) },
      { path: '/apps/:slug/distributions/:target/signing/new', element: page(<AppSigningNewPage />) },
    ],
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

const where = () => screen.getByTestId('where').textContent

const app = (over: Partial<AgentApp> = {}): AgentApp =>
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
    distributions: [
      { id: 'd-1', appId: 'app-1', target: 'whatsapp_cloud', status: 'draft', gatewayId: null, configuration: {} },
      { id: 'd-2', appId: 'app-1', target: 'discord', status: 'draft', gatewayId: null, configuration: {} },
      { id: 'd-3', appId: 'app-1', target: 'desktop', status: 'draft', gatewayId: null, configuration: {} },
    ],
    ...over,
  }) as AgentApp

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue([])
  api.getById.mockResolvedValue(app())
  api.check.mockResolvedValue({ ok: true, refusals: [] })
  api.checkDistribution.mockResolvedValue({ ok: true, refusals: [] })
  api.addDistribution.mockResolvedValue({})
  api.publishDistribution.mockResolvedValue({})
  api.unpublishDistribution.mockResolvedValue({})
  api.platforms.mockResolvedValue([])
  api.builds.mockResolvedValue([])
  api.capabilities.mockResolvedValue({ canBuild: true, buildReason: null, signing: [] })
})

describe('/apps/new', () => {
  it('is where "Create app" goes, from the header and the empty state', async () => {
    renderAt('/apps')
    await screen.findByText('No apps yet')
    const buttons = screen.getAllByRole('button', { name: 'Create app' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    await waitFor(() => expect(where()).toBe('/apps/new'))
    expect(screen.getByRole('heading', { level: 1, name: 'Create app' })).toBeInTheDocument()
  })

  it('keeps an old ?new=1 link landing on the create page', async () => {
    renderAt('/apps?new=1')
    await waitFor(() => expect(where()).toBe('/apps/new'))
  })

  it('asks for the agent first, names the app after it, then creates and opens it', async () => {
    api.create.mockResolvedValue({ slug: 'triage' })
    renderAt('/apps/new')

    fireEvent.click(await screen.findByLabelText(/^Agent/))
    fireEvent.click(await screen.findByRole('option', { name: 'Triage' }))
    // The name and the address follow the agent until someone types their own.
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Triage')
    expect(screen.getByLabelText(/^Address/)).toHaveValue('triage')
    fireEvent.click(screen.getByRole('button', { name: 'Create app' }))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        name: 'Triage',
        slug: 'triage',
        description: null,
        agentIds: ['triage-1'],
      }),
    )
    await waitFor(() => expect(where()).toBe('/apps/triage'))
  })

  it('keeps a name someone typed, with the address derived from it', async () => {
    api.create.mockResolvedValue({ slug: 'acme-help' })
    renderAt('/apps/new')
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Acme Help' } })
    fireEvent.click(await screen.findByLabelText(/^Agent/))
    fireEvent.click(await screen.findByRole('option', { name: 'Billing' }))
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Acme Help')
    expect(screen.getByLabelText(/^Address/)).toHaveValue('acme-help')
    fireEvent.click(screen.getByRole('button', { name: 'Create app' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Acme Help', agentIds: ['billing-2'] })))
  })

  it('refuses an app with no agent, and says why on the agent field', async () => {
    renderAt('/apps/new')
    const agent = await screen.findByLabelText(/^Agent/)
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Acme Help' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create app' }))

    await waitFor(() => expect(agent).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('Pick the agent people will talk to.')).toBeInTheDocument()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('links to making an agent when the organization has none', async () => {
    vi.mocked(agentsApi.getAll).mockResolvedValueOnce([] as any)
    renderAt('/apps/new')
    const none = await screen.findByTestId('app-no-agents')
    expect(within(none).getByRole('link', { name: 'Create an agent' })).toHaveAttribute('href', '/agents/new')
    fireEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(api.create).not.toHaveBeenCalled()
  })

  it('says what an app is in plain words, and keeps safe defaults out of the flow', async () => {
    renderAt('/apps/new')
    expect(screen.getByText(/An app puts your agent in front of people/)).toBeInTheDocument()
    expect(screen.getByText(/defaults are applied automatically/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Cost ceiling/i)).toBeNull()
    expect(screen.queryByText(/product/i)).toBeNull()
  })
})

describe('the app page', () => {
  it('links each distribution card to its own page', async () => {
    renderAt('/apps/support')
    fireEvent.click(await screen.findByText('WhatsApp (Meta)'))
    await waitFor(() => expect(where()).toBe('/apps/support/distributions/whatsapp_cloud'))
  })

  it('links "Add a place" to the picker page', async () => {
    renderAt('/apps/support')
    fireEvent.click(await screen.findByRole('link', { name: /Add a place/ }))
    await waitFor(() => expect(where()).toBe('/apps/support/distributions/new'))
  })

  it('leads with adding an agent while the app has none', async () => {
    api.getById.mockResolvedValue(app({ agentIds: [], distributions: [] }))
    renderAt('/apps/support')
    expect(await screen.findByRole('tab', { name: /Agents \(0\)/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('link', { name: /Add a place/ })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Add an agent' })).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Where people use it/ }))
    fireEvent.click(await screen.findByRole('tab', { name: /Where people use it/ }))
    const buttons = screen.getAllByRole('button', { name: /Add an agent/ })
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(screen.getByRole('tab', { name: /Agents \(0\)/ })).toHaveAttribute('aria-selected', 'true'))
  })

  it('says what stops the app from shipping, once, on the app page', async () => {
    api.check.mockResolvedValue({
      ok: false,
      refusals: [{ code: 'NO_AGENTS', message: 'An app needs an agent.' }],
    })
    renderAt('/apps/support')
    expect(await screen.findByText('An app needs an agent.')).toBeInTheDocument()
  })
})

describe('/apps/:slug/distributions/new', () => {
  it('adds the picked target and opens its page', async () => {
    renderAt('/apps/support/distributions/new')
    fireEvent.click(await screen.findByRole('button', { name: /^Slack/ }))
    await waitFor(() => expect(api.addDistribution).toHaveBeenCalledWith('support', 'slack'))
    await waitFor(() => expect(where()).toBe('/apps/support/distributions/slack'))
  })

  it('links a target the app already ships to instead of offering it again', async () => {
    renderAt('/apps/support/distributions/new')
    const existing = await screen.findByRole('link', { name: /WhatsApp \(Meta\)/ })
    expect(existing).toHaveAttribute('href', '/apps/support/distributions/whatsapp_cloud')
  })
})

describe('/apps/:slug/distributions/whatsapp_cloud', () => {
  it('names the platform once, with one sentence under it', async () => {
    renderAt('/apps/support/distributions/whatsapp_cloud')
    expect(await screen.findByRole('heading', { level: 1, name: 'WhatsApp (Meta)' })).toBeInTheDocument()
    expect(screen.getAllByText(/WhatsApp \(Meta\)/)).toHaveLength(1)
    expect(screen.queryByText(/Configure the/)).toBeNull()
  })

  it('shows the callback URL Meta asks for, next to the verify token', async () => {
    renderAt('/apps/support/distributions/whatsapp_cloud')
    const url = await screen.findByText('https://api.example.com/acme/apps/support/whatsapp_cloud')
    expect(url).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy callback url/i })).toBeInTheDocument()
    expect(screen.getByText(/WhatsApp → Configuration → Webhook/)).toBeInTheDocument()
  })

  it('labels every field in words, with where to find it', async () => {
    renderAt('/apps/support/distributions/whatsapp_cloud')
    for (const label of ['Access token', 'Phone number ID', 'App secret', 'Verify token']) {
      expect(await screen.findByLabelText(new RegExp(`^${label}`))).toBeInTheDocument()
    }
    expect(screen.getAllByText(/Meta for Developers → your app → WhatsApp → API Setup/).length).toBeGreaterThan(0)
    // No raw ids listed anywhere on the page.
    expect(screen.queryByText(/access_token|phone_number_id|app_secret|verify_token/)).toBeNull()
  })

  it('keeps password managers out, masking only the real secrets', async () => {
    renderAt('/apps/support/distributions/whatsapp_cloud')
    const token = await screen.findByLabelText(/^Access token/)
    expect(token).toHaveAttribute('type', 'password')
    expect(token).toHaveAttribute('data-1p-ignore', 'true')
    expect(token).toHaveAttribute('autocomplete', 'off')
    const phoneId = screen.getByLabelText(/^Phone number ID/)
    expect(phoneId).toHaveAttribute('type', 'text')
    expect(phoneId).toHaveAttribute('data-1p-ignore', 'true')
  })

  it('has exactly one save', async () => {
    renderAt('/apps/support/distributions/whatsapp_cloud')
    await screen.findByLabelText(/^Access token/)
    expect(screen.getAllByRole('button', { name: /save/i })).toHaveLength(1)
    const footer = screen.getByTestId('form-page-footer')
    expect(within(footer).getAllByRole('button').filter((b) => b.getAttribute('type') === 'submit')).toHaveLength(1)
  })

  it('does not repeat app-level readiness warnings inside the channel', async () => {
    api.checkDistribution.mockResolvedValue({
      ok: false,
      refusals: [
        { code: 'NO_AGENTS', message: 'An app needs an agent.' },
        { code: 'MISSING_CREDENTIALS', message: 'It still needs: access_token' },
      ],
    })
    renderAt('/apps/support/distributions/whatsapp_cloud')
    expect(await screen.findByText(/app itself is not ready/)).toBeInTheDocument()
    expect(screen.queryByText('An app needs an agent.')).toBeNull()
    expect(screen.queryByText(/It still needs/)).toBeNull()
    expect(screen.getAllByText('Needed before this can go live.').length).toBe(4)
  })

  it('saves only what changed, and never sends a stored secret back', async () => {
    api.getById.mockResolvedValue(
      app({
        distributions: [
          {
            id: 'd-1',
            appId: 'app-1',
            target: 'whatsapp_cloud',
            status: 'draft',
            gatewayId: null,
            configuration: { app_secret: '••••', phone_number_id: '111' },
          },
        ],
      }),
    )
    renderAt('/apps/support/distributions/whatsapp_cloud')

    fireEvent.change(await screen.findByLabelText(/^Access token/), { target: { value: 'EAAG-real' } })
    fireEvent.change(screen.getByLabelText(/^Verify token/), { target: { value: 'my-phrase' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.addDistribution).toHaveBeenCalledWith('support', 'whatsapp_cloud', {
        access_token: 'EAAG-real',
        verify_token: 'my-phrase',
      }),
    )
  })

  it('confirms before removing the distribution', async () => {
    api.removeDistribution.mockResolvedValue({})
    renderAt('/apps/support/distributions/whatsapp_cloud')
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('Remove WhatsApp (Meta) from this app?')
    expect(api.removeDistribution).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.removeDistribution).toHaveBeenCalledWith('support', 'whatsapp_cloud'))
    await waitFor(() => expect(where()).toBe('/apps/support'))
  })

  it('publishes, and repeats the blockers the backend lists when it refuses', async () => {
    api.publishDistribution.mockRejectedValue({
      response: { status: 400, data: { error: { message: 'No cost cap is set.' } } },
    })
    renderAt('/apps/support/distributions/whatsapp_cloud')
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not publish', 'No cost cap is set.'))
  })

  it('offers to unpublish a live one, saying the address is kept', async () => {
    api.getById.mockResolvedValue(
      app({
        distributions: [
          { id: 'd-1', appId: 'app-1', target: 'whatsapp_cloud', status: 'live', gatewayId: 'g', configuration: {} },
        ],
      }),
    )
    renderAt('/apps/support/distributions/whatsapp_cloud')
    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }))
    expect(screen.getByText(/keeps its address/i)).toBeInTheDocument()
    await waitFor(() => expect(api.unpublishDistribution).toHaveBeenCalledWith('support', 'whatsapp_cloud'))
  })
})

describe('other distribution pages', () => {
  it('Discord needs no callback URL and says why', async () => {
    renderAt('/apps/support/distributions/discord')
    expect(await screen.findByTestId('no-callback-url')).toHaveTextContent(/gateway/)
    expect(screen.queryByRole('button', { name: /copy callback url/i })).toBeNull()
  })

  it('a desktop app asks for a valid bundle identifier and focuses it', async () => {
    renderAt('/apps/support/distributions/desktop')
    const field = await screen.findByLabelText(/^Bundle identifier/)
    fireEvent.change(field, { target: { value: 'not a bundle id' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(api.addDistribution).not.toHaveBeenCalled()
    // A file is not published.
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('asks which agent answers when the app has more than one', async () => {
    api.getById.mockResolvedValue(app({ agentIds: ['triage-1', 'billing-2'] }))
    renderAt('/apps/support/distributions/discord')
    expect(await screen.findByLabelText('Answered by')).toHaveTextContent(/Triage \(the app default\)/)
  })

  it('saves the agent the surface answers with through the one Save', async () => {
    api.getById.mockResolvedValue(app({ agentIds: ['triage-1', 'billing-2'] }))
    renderAt('/apps/support/distributions/discord')
    fireEvent.click(await screen.findByLabelText('Answered by'))
    fireEvent.click(await screen.findByRole('option', { name: 'Billing' }))
    expect(api.addDistribution).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.addDistribution).toHaveBeenCalledWith('support', 'discord', { agentId: 'billing-2' }),
    )
  })

  it('says so when the app does not ship to the target in the URL', async () => {
    renderAt('/apps/support/distributions/slack')
    expect(await screen.findByText(/is not on Slack/)).toBeInTheDocument()
  })
})

describe('/apps/:slug/distributions/:target/signing/new', () => {
  const certificate = () =>
    new File([new Uint8Array([0x30, 0x82, 0x01])], 'developer-id.p12', { type: 'application/x-pkcs12' })

  it('stores the certificate and signs the distribution with it', async () => {
    ;(credentialsApi.create as any).mockResolvedValue({ data: { id: 'cred-9' } })
    renderAt('/apps/support/distributions/desktop/signing/new?kind=apple')

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Developer ID' } })
    fireEvent.change(screen.getByLabelText(/^Certificate file/), { target: { files: [certificate()] } })
    fireEvent.change(screen.getByLabelText(/^Certificate password/), { target: { value: 'hunter2' } })
    fireEvent.change(screen.getByLabelText(/^App Store Connect key ID/), { target: { value: 'ABCD1234EF' } })
    fireEvent.change(screen.getByLabelText(/^Issuer ID/), { target: { value: 'iss-1' } })
    fireEvent.change(screen.getByLabelText(/^Private key/), { target: { value: '-----BEGIN PRIVATE KEY-----' } })
    fireEvent.click(screen.getByRole('button', { name: 'Store certificate' }))

    await waitFor(() => expect(credentialsApi.create).toHaveBeenCalled())
    const payload = (credentialsApi.create as any).mock.calls[0][0]
    expect(payload.type).toBe('code_signing')
    expect(payload.config.certificate).toBe('MIIB')
    expect(payload.config.certificatePassword).toBe('hunter2')
    expect(payload.config.appleApiKeyId).toBe('ABCD1234EF')
    await waitFor(() =>
      expect(api.addDistribution).toHaveBeenCalledWith('support', 'desktop', { signingCredentialId: 'cred-9' }),
    )
    await waitFor(() => expect(where()).toBe('/apps/support/distributions/desktop'))
  })

  it('does not ask Windows for notarisation keys', async () => {
    renderAt('/apps/support/distributions/desktop/signing/new?kind=authenticode')
    await screen.findByLabelText(/^Certificate password/)
    expect(screen.queryByLabelText(/App Store Connect key ID/)).toBeNull()
  })

  it('refuses a missing password and focuses the first missing field', async () => {
    renderAt('/apps/support/distributions/desktop/signing/new?kind=authenticode')
    fireEvent.click(await screen.findByRole('button', { name: 'Store certificate' }))
    const name = screen.getByLabelText(/^Name/)
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByLabelText(/^Certificate password/)).toHaveAttribute('aria-invalid', 'true')
    expect(credentialsApi.create).not.toHaveBeenCalled()
  })

  it('refuses a file far too large to be a certificate', async () => {
    renderAt('/apps/support/distributions/desktop/signing/new?kind=authenticode')
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText(/^Certificate password/), { target: { value: 'pw' } })
    const huge = new File([new Uint8Array(600 * 1024)], 'huge.p12')
    fireEvent.change(screen.getByLabelText(/^Certificate file/), { target: { files: [huge] } })
    fireEvent.click(screen.getByRole('button', { name: 'Store certificate' }))
    expect(await screen.findByText(/too large/)).toBeInTheDocument()
    expect(credentialsApi.create).not.toHaveBeenCalled()
  })
})
