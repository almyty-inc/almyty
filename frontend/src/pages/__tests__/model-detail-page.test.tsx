import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { ModelDetailPage, whyNotUsable } from '../model-detail'
import { modelsApi } from '../../lib/models-api'
import { llmProvidersApi } from '../../lib/api'
import { modelAdaptersApi, modelDeploymentsApi } from '../../lib/deployments-api'
import { hfAdapter, makeDeployment } from '@/components/models/hosting/__tests__/fixtures'
import type { ModelCard } from '@/types/models'

vi.mock('../../lib/models-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/models-api')>('../../lib/models-api')
  return { ...actual, modelsApi: { list: vi.fn(), register: vi.fn(), sync: vi.fn(), update: vi.fn(), remove: vi.fn(), validate: vi.fn(), get: vi.fn() } }
})
vi.mock('../../lib/deployments-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/deployments-api')>('../../lib/deployments-api')
  return {
    ...actual,
    modelAdaptersApi: { list: vi.fn() },
    modelDeploymentsApi: { list: vi.fn(), create: vi.fn(), scale: vi.fn(), teardown: vi.fn(), delete: vi.fn(), get: vi.fn() },
    modelVersionsApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
  }
})
vi.mock('../../lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn(), getModels: vi.fn() },
  budgetsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('../../store/app', () => ({ useNotifications: () => notify }))

const navigate = vi.fn()
const params = { current: { id: 'h1' } as Record<string, string> }
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useParams: () => params.current, useNavigate: () => navigate }
})

function card(overrides: Partial<ModelCard> = {}): ModelCard {
  return {
    id: 'h1',
    organizationId: 'org',
    name: 'Support bot',
    providerId: 'p-managed',
    providerType: 'openai',
    vendorModelId: 'acme/support-bot-v3',
    endpointRef: { url: 'https://x.endpoints.huggingface.cloud', deploymentId: 'd-1', providerType: 'huggingface-endpoints' },
    base: null,
    modelVersionId: null,
    capabilities: { tools: true },
    contextLength: 32768,
    pricing: null,
    pricingSource: 'adapter',
    pricingFetchedAt: null,
    pricingOverride: null,
    measuredLatencyMs: null,
    privacyTier: 'private_cloud',
    region: null,
    status: 'active',
    validationStatus: 'never',
    lastValidatedAt: null,
    lastValidationError: null,
    metadata: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    selectable: false,
    effectivePricing: null,
    ...overrides,
  }
}

const running = () =>
  makeDeployment({ id: 'd-1', modelId: 'h1', providerType: 'huggingface-endpoints', state: 'ready', desired: { replicas: 1 }, actual: { state: 'ready', replicas: 1, ratePerHourCents: 120 } })

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<ModelDetailPage />, { queryClient })
}

describe('whyNotUsable', () => {
  it('says in one sentence what stands between a model and the agents', () => {
    expect(whyNotUsable(card({ selectable: true }))).toBeNull()
    expect(whyNotUsable(card({ status: 'deploying' }), running())).toMatch(/running on your cloud and a validation run passes/)
    expect(whyNotUsable(card({ endpointRef: null, providerId: null }))).toMatch(/no inference provider/)
    expect(whyNotUsable(card({ validationStatus: 'failed' }))).toMatch(/last validation run failed/)
    expect(whyNotUsable(card())).toMatch(/Validate it once/)
  })
})

describe('ModelDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    params.current = { id: 'h1' }
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([] as any)
    vi.mocked(modelAdaptersApi.list).mockResolvedValue([hfAdapter])
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([running()])
    vi.mocked(modelsApi.get).mockResolvedValue(card())
  })

  it('shows a hosted model with its cloud, state, hourly cost and controls on its own page', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Support bot', level: 1 })).toBeInTheDocument()
    const panel = await screen.findByTestId('hosting-panel')
    expect(within(panel).getByText('Your Hugging Face account (Inference Endpoint)')).toBeInTheDocument()
    expect(within(panel).getByText('Running')).toBeInTheDocument()
    expect(within(panel).getByText('$1.20/h')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stops it from its page, after a one-line confirmation', async () => {
    vi.mocked(modelDeploymentsApi.scale).mockResolvedValue(running())
    renderPage()
    const panel = await screen.findByTestId('hosting-panel')
    await userEvent.click(within(panel).getByRole('button', { name: 'Stop' }))
    expect(modelDeploymentsApi.scale).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(modelDeploymentsApi.scale).toHaveBeenCalledWith('d-1', 0))
  })

  it('edits the settings inline and saves them', async () => {
    vi.mocked(modelsApi.get).mockResolvedValue(card({ endpointRef: null, providerId: 'p1', providerType: 'anthropic' }))
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([])
    vi.mocked(modelsApi.update).mockResolvedValue(card())
    renderPage()
    const settings = await screen.findByRole('form', { name: 'Model settings' })
    const name = within(settings).getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Renamed')
    await userEvent.click(within(settings).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(modelsApi.update).toHaveBeenCalledWith('h1', expect.objectContaining({ name: 'Renamed' })))
  })

  it('will not remove a model that is still running on your cloud', async () => {
    renderPage()
    await screen.findByTestId('hosting-panel')
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
    expect(screen.getByText(/shut it down on your cloud first/)).toBeInTheDocument()
  })

  it('removes a model after confirmation and goes back to the list', async () => {
    vi.mocked(modelsApi.get).mockResolvedValue(card({ endpointRef: null, providerId: 'p1', providerType: 'anthropic' }))
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([])
    vi.mocked(modelsApi.remove).mockResolvedValue(undefined)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Remove this model?')).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!)
    await waitFor(() => expect(modelsApi.remove).toHaveBeenCalledWith('h1'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/models'))
  })
})
