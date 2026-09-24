/**
 * Removing a model while its inline settings form holds unsaved edits.
 *
 * The page asked "Remove this model?", removed it, navigated to the list
 * -- and the settings form's leave guard then asked "Discard unsaved
 * changes?" about edits to a model that no longer existed. One decision,
 * two prompts. The Remove confirm is the only question now.
 *
 * Under the real data router, so the blocker main.tsx mounts is the one
 * that runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks } from '@/test/leave-guard'
import { LEAVE_TITLE } from '@/hooks/use-leave-guard'
import { ModelDetailPage } from '../model-detail'
import { modelsApi } from '../../lib/models-api'
import { llmProvidersApi } from '../../lib/api'
import { modelAdaptersApi, modelDeploymentsApi } from '../../lib/deployments-api'
import type { ModelCard } from '@/types/models'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
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

const card = {
  id: 'h1',
  organizationId: 'org',
  name: 'Support bot',
  providerId: 'p1',
  providerType: 'anthropic',
  vendorModelId: 'claude',
  endpointRef: null,
  base: null,
  modelVersionId: null,
  capabilities: { tools: true },
  contextLength: 32768,
  pricing: null,
  pricingSource: 'feed',
  pricingFetchedAt: null,
  pricingOverride: null,
  measuredLatencyMs: null,
  privacyTier: 'standard',
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
} as unknown as ModelCard

describe('removing a model with unsaved settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([] as any)
    vi.mocked(modelAdaptersApi.list).mockResolvedValue([])
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([])
    vi.mocked(modelsApi.get).mockResolvedValue(card)
    vi.mocked(modelsApi.remove).mockResolvedValue(undefined)
  })

  const openDirty = async () => {
    const utils = renderAtRoute(<ModelDetailPage />, { path: '/models/:id', url: '/models/h1', paths: ['/models'] })
    const settings = await screen.findByRole('form', { name: 'Model settings' })
    await userEvent.type(within(settings).getByLabelText('Name'), ' edited')
    return utils
  }

  it('still asks before an ordinary navigation throws the edits away', async () => {
    const { router } = await openDirty()
    await expectLeaveAsks(router, '/models')
  })

  it('asks once, the Remove confirm, and lands on the list', async () => {
    const { router } = await openDirty()

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Remove this model?')).toBeInTheDocument()
    await act(async () => {
      await userEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!)
    })

    await waitFor(() => expect(modelsApi.remove).toHaveBeenCalledWith('h1'))
    expect(await screen.findByText('at /models')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/models')
    expect(screen.queryByText(LEAVE_TITLE)).not.toBeInTheDocument()
  })
})
