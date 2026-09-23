import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../../test/setup'
import { ModelsCatalog } from '../models-catalog'
import { RoutingPolicyField } from '../routing-policy-editor'
import { modelsApi } from '../../../lib/models-api'
import { llmProvidersApi } from '../../../lib/api'
import type { ModelCard } from '@/types/models'

// Validation is what flips a card to selectable, and the toast says so.
// The catalog only invalidated ['models','catalog'], and the two other
// consumers sit on sibling keys -- ['models','selectable'] for the
// routing policy editor and ['models','names'] for the agent Overview --
// so neither ever saw the change inside its staleTime.

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

vi.mock('../../../lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn(), getModels: vi.fn() },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  budgetsApi: { list: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../../lib/deployments-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/deployments-api')>('../../../lib/deployments-api')
  return {
    ...actual,
    modelAdaptersApi: { list: vi.fn().mockResolvedValue([]) },
    modelDeploymentsApi: { list: vi.fn().mockResolvedValue([]) },
    modelVersionsApi: { list: vi.fn().mockResolvedValue([]) },
  }
})

vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
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
    capabilities: { tools: true },
    contextLength: 200000,
    pricing: { inPerMTok: 3, outPerMTok: 15, currency: 'USD' },
    pricingSource: 'feed:litellm',
    pricingFetchedAt: null,
    pricingOverride: null,
    measuredLatencyMs: null,
    privacyTier: 'public',
    region: 'us-east',
    status: 'active',
    validationStatus: 'never',
    lastValidatedAt: null,
    lastValidationError: null,
    metadata: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    selectable: false,
    effectivePricing: { inPerMTok: 3, outPerMTok: 15, currency: 'USD' },
    ...overrides,
  } as ModelCard
}

describe('validating a card reaches every consumer of "usable"', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([
      { id: 'p1', name: 'Anthropic prod', type: 'anthropic' },
    ] as any)
  })

  it('lists the newly selectable card in the routing policy editor', async () => {
    let validated = false
    vi.mocked(modelsApi.list).mockImplementation(async (params?: any) => {
      if (params?.selectable) {
        return (validated ? [card({ validationStatus: 'passed', selectable: true })] : []) as any
      }
      return [validated ? card({ validationStatus: 'passed', selectable: true }) : card()] as any
    })
    vi.mocked(modelsApi.validate).mockImplementation(async () => {
      validated = true
      return { passed: true, latencyMs: 120 } as any
    })

    const user = userEvent.setup()
    render(
      <>
        <ModelsCatalog onAddModel={() => undefined} />
        <RoutingPolicyField value={{ objective: 'cheapest' }} onChange={() => {}} />
      </>,
      { queryClient },
    )

    expect(await screen.findByText('Sonnet')).toBeInTheDocument()
    // The policy editor has nothing selectable to offer yet.
    await waitFor(() =>
      expect(
        queryClient.getQueryData(['models', 'selectable']),
      ).toEqual([]),
    )

    await user.click(screen.getByRole('button', { name: 'Actions for Sonnet' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Validate' }))


    await waitFor(() => expect(modelsApi.validate).toHaveBeenCalled())
    // The sibling key has to be refetched, or the editor keeps the
    // pre-validation answer for its whole staleTime.
    await waitFor(() =>
      expect(
        (queryClient.getQueryData(['models', 'selectable']) as any[])?.length,
      ).toBe(1),
    )
    expect(
      (queryClient.getQueryData(['models', 'selectable']) as any[])[0].id,
    ).toBe('c1')
  })

  it('refreshes the model-name lookup the agent Overview reads', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card()] as any)
    vi.mocked(modelsApi.validate).mockResolvedValue({ passed: true, latencyMs: 90 } as any)
    // Seed the sibling key the agent Overview uses, with its own 5 min
    // staleTime; a catalog-only invalidate left this untouched.
    queryClient.setQueryData(['models', 'names'], [card()])

    const user = userEvent.setup()
    render(<ModelsCatalog onAddModel={() => undefined} />, { queryClient })

    expect(await screen.findByText('Sonnet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Actions for Sonnet' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Validate' }))


    await waitFor(() => expect(modelsApi.validate).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['models', 'names'])?.isInvalidated,
      ).toBe(true),
    )
  })
})
