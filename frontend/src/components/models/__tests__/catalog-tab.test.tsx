import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../../test/setup'
import { CatalogTab } from '../catalog-tab'
import { modelsApi } from '../../../lib/models-api'
import { llmProvidersApi } from '../../../lib/api'
import type { ModelCard } from '@/types/models'

vi.mock('../../../lib/models-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/models-api')>('../../../lib/models-api')
  return {
    ...actual,
    modelsApi: {
      list: vi.fn(),
      get: vi.fn(),
      register: vi.fn(),
      registerEndpoint: vi.fn(),
      sync: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      validate: vi.fn(),
    },
  }
})

vi.mock('../../../lib/api', () => ({
  llmProvidersApi: {
    getAll: vi.fn(),
    getModels: vi.fn(),
  },
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

describe('CatalogTab', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([{ id: 'p1', name: 'Anthropic prod', type: 'anthropic' }] as any)
  })

  it('renders cards with provider, price source, capabilities and validation states', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(),
      card({
        id: 'c2',
        name: 'Local Qwen',
        vendorModelId: 'qwen3-14b',
        providerId: null,
        providerType: 'custom',
        endpointRef: { url: 'http://10.0.0.5:8000/v1' },
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

    render(<CatalogTab />, { queryClient })

    expect(await screen.findByText('Sonnet')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument()
    expect(screen.getAllByText('Anthropic prod')).toHaveLength(2)
    expect(screen.getByText('http://10.0.0.5:8000/v1')).toBeInTheDocument()

    // Effective price with its source; an override shows as Override.
    expect(screen.getByText('$3.00 in / $15.00 out')).toBeInTheDocument()
    expect(screen.getByText('LiteLLM feed')).toBeInTheDocument()
    expect(screen.getByText('$1.00 in / $2.00 out')).toBeInTheDocument()
    expect(screen.getByText('Override')).toBeInTheDocument()
    expect(screen.getByText('Unpriced')).toBeInTheDocument()

    // Capabilities as badges, context length compacted.
    expect(screen.getAllByText('Tools').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Vision').length).toBeGreaterThan(0)
    expect(screen.getAllByText('200k').length).toBe(2)
    expect(screen.getByText('33k')).toBeInTheDocument()

    // Validation states: passed, failed with the error as tooltip, never.
    expect(screen.getByText('Passed')).toBeInTheDocument()
    const failed = screen.getByText('Failed').closest('[title]')
    expect(failed).toHaveAttribute('title', 'connect ECONNREFUSED')
    expect(screen.getByText('Not validated')).toBeInTheDocument()

    // Selectable indicator follows the support rule.
    expect(screen.getAllByText('Selectable')).toHaveLength(1)
    expect(screen.getAllByText('Not selectable')).toHaveLength(2)

    // Summary line counts usable cards.
    expect(screen.getByText(/3 cards, 1 usable by agents/)).toBeInTheDocument()
  })

  it('filters to selectable cards only', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(),
      card({ id: 'c2', name: 'Unvalidated', vendorModelId: 'x', validationStatus: 'never', selectable: false }),
    ])
    render(<CatalogTab />, { queryClient })
    expect(await screen.findByText('Unvalidated')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Selectable only' }))

    await waitFor(() => expect(screen.queryByText('Unvalidated')).not.toBeInTheDocument())
    expect(screen.getByText('Sonnet')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 shown')).toBeInTheDocument()
  })

  it('shows the empty state that explains sync and validation', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([])
    render(<CatalogTab />, { queryClient })
    expect(await screen.findByText('No model cards yet')).toBeInTheDocument()
    expect(screen.getByText(/appear automatically when you sync a configured provider/)).toBeInTheDocument()
    expect(screen.getByText(/become usable after a validation run passes/)).toBeInTheDocument()
  })

  it('shows a query error with retry when the list fails', async () => {
    vi.mocked(modelsApi.list).mockRejectedValue(new Error('boom'))
    render(<CatalogTab />, { queryClient })
    expect(await screen.findByText("Couldn't load the catalog")).toBeInTheDocument()
  })

  it('runs a validation from the row menu and reports the outcome', async () => {
    const failing = card({ id: 'c9', name: 'Flaky', vendorModelId: 'flaky-1', validationStatus: 'never', selectable: false })
    vi.mocked(modelsApi.list).mockResolvedValue([failing])
    vi.mocked(modelsApi.validate).mockResolvedValue({ passed: false, latencyMs: 40, error: 'model retired', model: failing })

    render(<CatalogTab />, { queryClient })
    expect(await screen.findByText('Flaky')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Flaky' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Validate' }))

    await waitFor(() => expect(modelsApi.validate).toHaveBeenCalledWith('c9'))
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Validation failed', 'model retired'))
  })

  it('syncs all providers without a body', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card()])
    vi.mocked(modelsApi.sync).mockResolvedValue({ created: [card({ id: 'n1' })], skipped: [] })

    render(<CatalogTab />, { queryClient })
    expect(await screen.findByText('Sonnet')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Sync from providers/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'All providers' }))

    await waitFor(() => expect(modelsApi.sync).toHaveBeenCalledWith(undefined))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Sync complete', expect.stringContaining('1 new card from all providers')))
  })
})
