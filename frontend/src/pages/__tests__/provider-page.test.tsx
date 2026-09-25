/**
 * /models/providers/:id: one connected provider, with everything a first
 * look needs up top and the rest under Advanced.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { ProviderPage } from '../provider'
import { llmProvidersApi, organizationsApi } from '@/lib/api'
import { modelsApi } from '@/lib/models-api'
import { modelAdaptersApi, modelDeploymentsApi } from '@/lib/deployments-api'
import { hfAdapter, makeDeployment } from '@/components/models/hosting/__tests__/fixtures'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getById: vi.fn(), getAll: vi.fn(), update: vi.fn(), test: vi.fn(), delete: vi.fn() },
  organizationsApi: { getTeams: vi.fn() },
  budgetsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/models-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models-api')>('@/lib/models-api')
  return { ...actual, modelsApi: { list: vi.fn(), sync: vi.fn(), update: vi.fn() } }
})
vi.mock('@/lib/deployments-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/deployments-api')>('@/lib/deployments-api')
  return {
    ...actual,
    modelAdaptersApi: { list: vi.fn() },
    modelDeploymentsApi: { list: vi.fn(), create: vi.fn(), scale: vi.fn(), teardown: vi.fn() },
  }
})
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))
// The default-model picker has its own tests; here it only has to be the locked one.
vi.mock('@/components/model-picker', () => ({
  ModelPicker: (props: any) =>
    React.createElement('div', { 'data-testid': 'default-model-picker', 'data-locked': String(!!props.providerLocked), 'data-provider': props.value.providerId }),
}))

const NOW = '2026-09-25T10:00:00.000Z'
const OPENAI = { id: 'p1', name: 'OpenAI', type: 'openai', status: 'active', visibility: 'org', teamId: null, lastSuccessAt: NOW, configuration: { apiKey: '***masked***', model: 'gpt-4o' } }

const card = (vendorModelId: string, over: Record<string, any> = {}) =>
  ({
    id: `card-${vendorModelId}`,
    name: vendorModelId,
    vendorModelId,
    providerId: 'p1',
    status: 'active',
    selectable: true,
    validationStatus: 'passed',
    pricing: { inPerMTok: 2.5, outPerMTok: 10 },
    pricingOverride: null,
    pricingSource: 'feed:litellm',
    contextLength: 128000,
    privacyTier: 'public',
    region: null,
    capabilities: {},
    metadata: null,
    updatedAt: NOW,
    ...over,
  }) as any

const at = () => renderAtRoute(<ProviderPage />, { path: '/models/providers/:id', url: '/models/providers/p1', paths: ['/models'] })

describe('ProviderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(llmProvidersApi.getById).mockResolvedValue(OPENAI as any)
    vi.mocked(organizationsApi.getTeams).mockResolvedValue([])
    vi.mocked(modelsApi.list).mockResolvedValue([card('gpt-4o'), card('o3')])
    vi.mocked(modelAdaptersApi.list).mockResolvedValue([hfAdapter])
    vi.mocked(modelDeploymentsApi.list).mockResolvedValue([])
  })

  it('shows the name, whether the key works, and its models', async () => {
    at()
    expect(await screen.findByRole('heading', { name: 'OpenAI' })).toBeInTheDocument()
    expect(screen.getByTestId('provider-status')).toHaveTextContent('Key works')
    expect(await screen.findByTestId('model-row-card-gpt-4o')).toHaveTextContent('$2.50 in / $10.00 out')
    expect(screen.getByTestId('model-row-card-o3')).toBeInTheDocument()
    expect(modelsApi.list).toHaveBeenCalledWith({ providerId: 'p1' })
    // Its default model is picked among its own models only.
    expect(screen.getByTestId('default-model-picker')).toHaveAttribute('data-locked', 'true')
    expect(screen.getByTestId('default-model-picker')).toHaveAttribute('data-provider', 'p1')
  })

  it('says the key was rejected, in the provider words', async () => {
    vi.mocked(llmProvidersApi.getById).mockResolvedValue({ ...OPENAI, status: 'error', lastSuccessAt: null, lastError: '401 Incorrect API key provided', lastErrorAt: NOW } as any)
    vi.mocked(modelsApi.list).mockResolvedValue([card('gpt-4o', { selectable: false })])
    at()
    expect(await screen.findByTestId('provider-status')).toHaveTextContent('Key rejected')
    expect(screen.getByTestId('provider-last-error')).toHaveTextContent('401 Incorrect API key provided')
  })

  it('checks again: the key, then the model list, then shows the answer', async () => {
    vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: true, responseTime: 120 } as any)
    vi.mocked(modelsApi.sync).mockResolvedValue({ created: [], skipped: [] } as any)
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    expect(await screen.findByTestId('provider-check-result')).toHaveTextContent('Key works. 2 models.')
    expect(llmProvidersApi.test).toHaveBeenCalledWith('p1')
    expect(modelsApi.sync).toHaveBeenCalledWith('p1')
    expect(vi.mocked(llmProvidersApi.test).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(modelsApi.sync).mock.invocationCallOrder[0])
  })

  it('does not fetch models when the key fails the check', async () => {
    vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: false, error: 'OpenAI rejected this key.' } as any)
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    expect(await screen.findByTestId('provider-check-result')).toHaveTextContent('OpenAI rejected this key.')
    expect(modelsApi.sync).not.toHaveBeenCalled()
  })

  it('renames in place', async () => {
    vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'OpenAI prod' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { name: 'OpenAI prod' }))
  })

  it('replaces the key inline and checks it again', async () => {
    vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
    vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: true } as any)
    vi.mocked(modelsApi.sync).mockResolvedValue({ created: [], skipped: [] } as any)
    at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'sk-new-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and check' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { credentialId: null, configuration: { apiKey: 'sk-new-1234567890' } }))
    await waitFor(() => expect(llmProvidersApi.test).toHaveBeenCalledWith('p1'))
  })

  it('shows who can use it as one line until changed', async () => {
    vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
    at()
    const line = await screen.findByTestId('who-can-use')
    expect(line).toHaveTextContent('Who can use it: everyone in your organization')
    expect(screen.queryByRole('radio', { name: /Private/ })).not.toBeInTheDocument()
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }))
    fireEvent.click(screen.getByRole('radio', { name: /Private/ }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { visibility: 'private', teamId: null }))
  })

  it('keeps per-model settings and call settings under Advanced', async () => {
    vi.mocked(modelsApi.update).mockResolvedValue({} as any)
    at()
    await screen.findByTestId('model-row-card-o3')
    expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Context length')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByLabelText('Temperature')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Model to change' }), { target: { value: 'card-o3' } })
    fireEvent.change(await screen.findByLabelText('Context length'), { target: { value: '200000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(modelsApi.update).toHaveBeenCalledWith('card-o3', expect.objectContaining({ contextLength: 200000 })))
  })

  it('has no validate step and no dialogs besides the one-line remove confirmation', async () => {
    vi.mocked(llmProvidersApi.delete).mockResolvedValue({} as any)
    at()
    await screen.findByTestId('model-row-card-o3')
    expect(screen.queryByRole('button', { name: /Validate/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Validated|Not validated/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove provider' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Remove OpenAI?')).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove provider' }))
    await waitFor(() => expect(llmProvidersApi.delete).toHaveBeenCalledWith('p1'))
    expect(await screen.findByText('at /models')).toBeInTheDocument()
  })

  it('offers no hosting on a provider that is not a cloud account', async () => {
    at()
    await screen.findByTestId('model-row-card-o3')
    expect(screen.queryByRole('button', { name: 'Start a model' })).not.toBeInTheDocument()
    expect(modelAdaptersApi.list).not.toHaveBeenCalled()
  })

  describe('a cloud account', () => {
    const HF = { ...OPENAI, id: 'p1', name: 'Hugging Face', type: 'huggingface', credentialRef: { id: 'conn-hf', name: 'HF', connectorKey: 'huggingface', healthStatus: 'valid' } }

    beforeEach(() => {
      vi.mocked(llmProvidersApi.getById).mockResolvedValue(HF as any)
    })

    it('starts an open model asking only which one, with the account it is connected with', async () => {
      vi.mocked(modelDeploymentsApi.create).mockResolvedValue({} as any)
      at()
      fireEvent.click(await screen.findByRole('button', { name: 'Start a model' }))
      fireEvent.change(screen.getByLabelText('Which model?'), { target: { value: 'Qwen/Qwen3-0.6B' } })
      fireEvent.click(screen.getByRole('button', { name: 'Start' }))
      await waitFor(() => expect(modelDeploymentsApi.create).toHaveBeenCalled())
      expect(vi.mocked(modelDeploymentsApi.create).mock.calls[0][0]).toMatchObject({
        providerType: 'huggingface-endpoints',
        model: 'hf://Qwen/Qwen3-0.6B',
        credentialId: 'conn-hf',
      })
    })

    it('lists what runs on the account, with its state and controls', async () => {
      vi.mocked(modelDeploymentsApi.list).mockResolvedValue([
        makeDeployment({ id: 'd-1', providerType: 'huggingface-endpoints', modelRef: 'hf://Qwen/Qwen3-0.6B@abc', state: 'ready' }),
        makeDeployment({ id: 'd-2', providerType: 'modal', state: 'ready' }),
      ])
      at()
      const panels = await screen.findAllByTestId('hosting-panel')
      expect(panels).toHaveLength(1)
      // Only this account's model; the Modal one belongs to another provider.
      expect(panels[0]).toHaveTextContent('Qwen/Qwen3-0.6B')
      expect(within(panels[0]).getByRole('button', { name: /Stop/ })).toBeInTheDocument()
    })
  })
})
