import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../../test/setup'
import { ModelsCatalog } from '../models-catalog'
import { modelsApi } from '../../../lib/models-api'
import { llmProvidersApi } from '../../../lib/api'
import { modelAdaptersApi, modelDeploymentsApi } from '../../../lib/deployments-api'
import type { ModelCard } from '@/types/models'
import { hfAdapter, makeDeployment } from '../hosting/__tests__/fixtures'

vi.mock('../../../lib/models-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/models-api')>('../../../lib/models-api')
  return {
    ...actual,
    modelsApi: {
      list: vi.fn(),
      get: vi.fn(),
      register: vi.fn(),
      sync: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      validate: vi.fn(),
    },
  }
})

vi.mock('../../../lib/deployments-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/deployments-api')>('../../../lib/deployments-api')
  return {
    ...actual,
    modelAdaptersApi: { list: vi.fn() },
    modelDeploymentsApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), scale: vi.fn(), teardown: vi.fn(), delete: vi.fn() },
    modelVersionsApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
  }
})

vi.mock('../../../lib/api', () => ({
  llmProvidersApi: {
    getAll: vi.fn(),
    getModels: vi.fn(),
  },
  budgetsApi: { list: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('../../../store/app', () => ({
  useNotifications: () => notify,
}))

function card(overrides: Partial<ModelCard> = {}): ModelCard {
  return {
    id: 'c1',
    organizationId: 'org',
    name: 'Sonnet',
    providerId: 'p1',
    providerType: 'anthropic',
    vendorModelId: 'claude-sonnet-5',
    endpointRef: null,
    base: null,
    modelVersionId: null,
    capabilities: { tools: true, vision: true },
    contextLength: 200000,
    pricing: { inPerMTok: 3, outPerMTok: 15, currency: 'USD' },
    pricingSource: 'feed:litellm',
    pricingFetchedAt: null,
    pricingOverride: null,
    measuredLatencyMs: null,
    privacyTier: 'public',
    region: 'us-east',
    status: 'active',
    validationStatus: 'passed',
    lastValidatedAt: '2026-09-01T00:00:00.000Z',
    lastValidationError: null,
    metadata: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    selectable: true,
    effectivePricing: { inPerMTok: 3, outPerMTok: 15, currency: 'USD' },
    ...overrides,
  }
}

/** A model hosted on the org's own Hugging Face account, running and billing. */
function hostedCard(overrides: Partial<ModelCard> = {}): ModelCard {
  return card({
    id: 'h1',
    name: 'Support bot',
    vendorModelId: 'acme/support-bot-v3',
    providerId: 'p-managed',
    providerType: 'openai',
    endpointRef: { url: 'https://x.endpoints.huggingface.cloud', deploymentId: 'd-1', providerType: 'huggingface-endpoints' },
    privacyTier: 'private_cloud',
    region: null,
    pricingSource: 'adapter',
    ...overrides,
  })
}

const running = () =>
  makeDeployment({
    id: 'd-1',
    modelId: 'h1',
    providerType: 'huggingface-endpoints',
    state: 'ready',
    desired: { replicas: 1 },
    actual: { state: 'ready', replicas: 1, ratePerHourCents: 120, spentCents: 480, url: 'https://x.endpoints.huggingface.cloud' },
    budgetId: 'b-1',
  })

describe('ModelsCatalog', () => {
  let queryClient: QueryClient
  const onAddModel = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([
      { id: 'p1', name: 'Anthropic prod', type: 'anthropic' },
      { id: 'p-box', name: 'Office box', type: 'custom', configuration: { apiUrl: 'http://10.0.0.5:8000/v1' } },
    ] as any)
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([])
    vi.mocked(modelAdaptersApi.list).mockResolvedValue([hfAdapter])
  })

  it('labels the view toggle without literal escape characters', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card()])
    render(<ModelsCatalog />, { queryClient })

    const grid = await screen.findByRole('button', { name: 'Grid', exact: true })
    expect(grid).toHaveTextContent(/^Grid$/)
    expect(grid).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Table', exact: true }))
    expect(grid).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(grid)
    expect(grid).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders every model the same way, with where it runs and what it costs', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(),
      card({
        id: 'c2',
        name: 'Local Qwen',
        vendorModelId: 'qwen3-14b',
        providerId: 'p-box',
        providerType: 'custom',
        privacyTier: 'local',
        region: null,
        validationStatus: 'failed',
        lastValidationError: 'connect ECONNREFUSED',
        selectable: false,
        pricing: null,
        pricingSource: 'unpriced',
        effectivePricing: null,
        capabilities: {},
        contextLength: 32768,
      }),
      card({
        id: 'c3',
        name: 'Fresh sync',
        vendorModelId: 'gpt-5-mini',
        validationStatus: 'never',
        lastValidatedAt: null,
        selectable: false,
        pricingOverride: { inPerMTok: 1, outPerMTok: 2, currency: 'USD' },
        effectivePricing: { inPerMTok: 1, outPerMTok: 2, currency: 'USD' },
      }),
    ])

    render(<ModelsCatalog />, { queryClient })

    expect(await screen.findByText('Sonnet')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument()

    // Runs on: the provider's API by its type, a server you run by its host.
    expect(await screen.findAllByText('Anthropic API, us-east')).toHaveLength(2)
    expect(screen.getByText('Your server (10.0.0.5:8000)')).toBeInTheDocument()

    // Effective price with its source; an override shows as Override.
    expect(screen.getByText('$3.00 in / $15.00 out')).toBeInTheDocument()
    expect(screen.getByText('LiteLLM feed')).toBeInTheDocument()
    expect(screen.getByText('$1.00 in / $2.00 out')).toBeInTheDocument()
    expect(screen.getByText('Override')).toBeInTheDocument()
    expect(screen.getByText('Unpriced')).toBeInTheDocument()

    expect(screen.getAllByText('Tools').length).toBeGreaterThan(0)
    expect(screen.getAllByText('200k').length).toBe(2)
    expect(screen.getByText('33k')).toBeInTheDocument()

    expect(screen.getByText('Passed')).toBeInTheDocument()
    const failed = screen.getByText('Failed').closest('[title]')
    expect(failed).toHaveAttribute('title', 'connect ECONNREFUSED')
    expect(screen.getByText('Not validated')).toBeInTheDocument()

    expect(screen.getAllByText('Selectable')).toHaveLength(1)
    expect(screen.getAllByText('Not selectable')).toHaveLength(2)

    // Where it runs is a badge, not a different layout.
    expect(screen.getAllByText('Provider API')).toHaveLength(2)
    expect(screen.getByText('Your server')).toBeInTheDocument()
  })

  it('shows a hosted model as a model: its cloud account, running state, hourly cost and cap', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card(), hostedCard()])
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([running()])
    render(<ModelsCatalog />, { queryClient })

    const tile = await screen.findByTestId('catalog-card-h1')
    await waitFor(() => expect(within(tile).getByText('Your Hugging Face account (Inference Endpoint)')).toBeInTheDocument())
    expect(within(tile).getByText('Running')).toBeInTheDocument()
    expect(within(tile).getByText('$1.20/h')).toBeInTheDocument()
    expect(within(tile).getByText('Capped by a budget')).toBeInTheDocument()
    expect(within(tile).getByText('Your cloud')).toBeInTheDocument()
    // The vendor-key model next to it carries no hosting state at all.
    expect(within(screen.getByTestId('catalog-card-c1')).queryByText('Running')).not.toBeInTheDocument()
  })

  it('opens each model on a page of its own, not in a dialog or sheet', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([hostedCard()])
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([running()])
    render(<ModelsCatalog />, { queryClient })

    expect(await screen.findByRole('link', { name: 'Open Support bot' })).toHaveAttribute('href', '/models/h1')
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Support bot' }))
    expect(await screen.findByRole('menuitem', { name: 'Edit settings' })).toHaveAttribute('href', '/models/h1#settings')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('will not remove a hosted model that is still on the cloud', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([hostedCard()])
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([running()])
    render(<ModelsCatalog />, { queryClient })

    await screen.findByText('Running')
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Support bot' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
    expect(await screen.findByText(/is still on your cloud\. Shut it down from its page first/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(modelsApi.remove).not.toHaveBeenCalled()
  })

  it('never lets a hosted model without a list entry disappear', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card()])
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([
      makeDeployment({ id: 'd-9', modelId: null, providerType: 'huggingface-endpoints', state: 'deploying', modelRef: 'hf://meta-llama/Llama-3.1-8B-Instruct@abc' }),
    ])
    render(<ModelsCatalog />, { queryClient })
    const tile = await screen.findByTestId('hosted-only-d-9')
    expect(within(tile).getByText('Llama-3.1-8B-Instruct')).toBeInTheDocument()
    expect(within(tile).getByText('Starting')).toBeInTheDocument()
  })

  it('says what the agents can use right now and across how many vendors', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(),
      card({ id: 'c2', name: 'Kimi', vendorModelId: 'kimi-k2', providerId: 'p2', providerType: 'moonshot' }),
      card({ id: 'c3', name: 'Unvalidated', vendorModelId: 'x', validationStatus: 'never', selectable: false }),
    ])
    render(<ModelsCatalog />, { queryClient })
    const summary = await screen.findByTestId('catalog-summary')
    expect(summary).toHaveTextContent('2 of 3 models')
    expect(summary).toHaveTextContent('across 2 vendors')
    expect(screen.getByTestId('catalog-vendors')).toHaveTextContent('moonshot')
  })

  it('picks several models across vendors into one routing policy', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(),
      card({ id: 'c2', name: 'Kimi', vendorModelId: 'kimi-k2', providerId: 'p2', providerType: 'moonshot' }),
    ])
    render(<ModelsCatalog />, { queryClient })
    expect(await screen.findByText('Sonnet')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Add Sonnet to the routing set' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Add Kimi to the routing set' }))

    const bar = await screen.findByTestId('routing-set-bar')
    expect(bar).toHaveTextContent('2 models across 2 vendors, run together')
    expect(screen.getByRole('button', { name: /Copy routing policy/ })).toBeInTheDocument()
  })

  it('filters to usable models only', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(),
      card({ id: 'c2', name: 'Unvalidated', vendorModelId: 'x', validationStatus: 'never', selectable: false }),
    ])
    render(<ModelsCatalog />, { queryClient })
    expect(await screen.findByText('Unvalidated')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Usable only' }))

    await waitFor(() => expect(screen.queryByText('Unvalidated')).not.toBeInTheDocument())
    expect(screen.getByText('Sonnet')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 shown')).toBeInTheDocument()
  })

  it('shows an empty state whose action is Add model, and offers sync when a provider exists', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([])
    render(<ModelsCatalog />, { queryClient })
    expect(await screen.findByText('No models yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add model' })).toHaveAttribute('href', '/models/new')
    expect(await screen.findByRole('button', { name: /Sync from providers/ })).toBeInTheDocument()
  })

  it('shows a query error with retry when the list fails', async () => {
    vi.mocked(modelsApi.list).mockRejectedValue(new Error('boom'))
    render(<ModelsCatalog />, { queryClient })
    expect(await screen.findByText("Couldn't load your models")).toBeInTheDocument()
  })

  it('runs a validation from the row menu and reports the outcome', async () => {
    const failing = card({ id: 'c9', name: 'Flaky', vendorModelId: 'flaky-1', validationStatus: 'never', selectable: false })
    vi.mocked(modelsApi.list).mockResolvedValue([failing])
    vi.mocked(modelsApi.validate).mockResolvedValue({ passed: false, latencyMs: 40, error: 'model retired', model: failing })

    render(<ModelsCatalog />, { queryClient })
    expect(await screen.findByText('Flaky')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Flaky' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Validate' }))

    await waitFor(() => expect(modelsApi.validate).toHaveBeenCalledWith('c9'))
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Validation failed', 'model retired'))
  })

  it('syncs all inference providers without a body', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card()])
    vi.mocked(modelsApi.sync).mockResolvedValue({ created: [card({ id: 'n1' })], skipped: [] })

    render(<ModelsCatalog />, { queryClient })
    expect(await screen.findByText('Sonnet')).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: /Sync from providers/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'All inference providers' }))

    await waitFor(() => expect(modelsApi.sync).toHaveBeenCalledWith(undefined))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Sync complete', expect.stringContaining('1 new model from all inference providers')))
  })
})
