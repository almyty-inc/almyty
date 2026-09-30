/**
 * /credentials/providers/:id: one provider connection. Its name, whether its key
 * works and which of its models it offers up top; the models tab ticks and
 * unticks them; settings holds the key, who can use it and Advanced.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { ProviderPage, removeDescription } from '../provider'
import { llmProvidersApi, organizationsApi } from '@/lib/api'
import { modelsApi } from '@/lib/models-api'
import { modelAdaptersApi, modelDeploymentsApi } from '@/lib/deployments-api'
import { hfAdapter, makeDeployment } from '@/components/models/hosting/__tests__/fixtures'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getById: vi.fn(), getAll: vi.fn(), update: vi.fn(), test: vi.fn(), delete: vi.fn(), agents: vi.fn() },
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
const OPENAI = { id: 'p1', name: 'OpenAI', type: 'openai', status: 'active', visibility: 'org', teamId: null, lastSuccessAt: NOW, keyChecked: true, configuration: { apiKey: '***masked***', model: 'gpt-4o' } }

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

const at = (tab?: string) => renderAtRoute(<ProviderPage />, { path: '/credentials/providers/:id', url: `/credentials/providers/p1${tab ? `?tab=${tab}` : ''}`, paths: ['/models', '/credentials'] })

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

  it('shows the name, whether the key works, and which models it offers', async () => {
    at()
    expect(await screen.findByRole('heading', { name: 'OpenAI' })).toBeInTheDocument()
    expect(screen.getByTestId('provider-status')).toHaveTextContent('Key works')
    expect(await screen.findByTestId('allowed-model-gpt-4o')).toHaveTextContent('$2.50 in / $10.00 out')
    expect(screen.getByTestId('allowed-model-o3')).toBeInTheDocument()
    expect(screen.getByTestId('connection-model-summary')).toHaveTextContent('All 2 models, and new ones')
    expect(modelsApi.list).toHaveBeenCalledWith({ providerId: 'p1' })
  })

  it('unticks a model to stop offering it, keeping new models on', async () => {
    vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
    at()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Allow o3' }))
    expect(screen.getByTestId('ticked-count')).toHaveTextContent('1 of 2 models ticked')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { allowNewModels: true, hiddenModels: ['o3'], allowedModels: null }))
  })

  it('pins the connection to the ticked models when new models are not allowed automatically', async () => {
    vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
    at()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Allow o3' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Allow new models automatically' }))
    expect(screen.getByText(/stay unticked until you tick them/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { allowNewModels: false, hiddenModels: ['o3'], allowedModels: ['gpt-4o'] }))
  })

  it('saves a connection with no model ticked: it is paused, not refused', async () => {
    vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
    at()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Untick every model shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', expect.objectContaining({ allowNewModels: true, hiddenModels: expect.arrayContaining(['gpt-4o', 'o3']) })))
    expect(screen.queryByTestId('allowed-models-error')).not.toBeInTheDocument()
  })

  it('says which agents use a model when unticking it is refused, and keeps it ticked', async () => {
    vi.mocked(llmProvidersApi.update).mockRejectedValue({
      response: { status: 409, data: { code: 'MODEL_IN_USE', message: '"o3" is used by Support triage. Pick another model for those agents first, then turn it off.', agents: [{ id: 'a1', name: 'Support triage' }], otherAgents: 0 } },
    })
    at()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Allow o3' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByTestId('allowed-models-error')).toHaveTextContent('"o3" is used by Support triage. Pick another model for those agents first, then turn it off.')
  })

  it('reads a pinned connection back as pinned', async () => {
    vi.mocked(llmProvidersApi.getById).mockResolvedValue({ ...OPENAI, allowNewModels: false, allowedModels: ['gpt-4o'], hiddenModels: null } as any)
    at()
    expect(await screen.findByTestId('allowed-model-o3')).toHaveAttribute('data-state', 'unchecked')
    expect(screen.getByTestId('allowed-model-gpt-4o')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('switch', { name: 'Allow new models automatically' })).toHaveAttribute('data-state', 'unchecked')
    expect(screen.getByTestId('connection-model-summary')).toHaveTextContent('Only gpt-4o')
  })

  it('says the key was rejected, in the provider words', async () => {
    vi.mocked(llmProvidersApi.getById).mockResolvedValue({ ...OPENAI, status: 'error', keyChecked: false, lastSuccessAt: null, lastError: '401 Incorrect API key provided', lastErrorAt: NOW } as any)
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
    const name = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'OpenAI prod' } })
    fireEvent.click(within(name.closest('form')!).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { name: 'OpenAI prod' }))
  })

  describe('a connection that is inactive', () => {
    const INACTIVE = { ...OPENAI, status: 'inactive', keyChecked: false, isHealthy: false, lastSuccessAt: null, lastHealthCheckAt: NOW, lastError: '401 Incorrect API key provided.', lastErrorAt: NOW, inactiveReason: 'check_failed' }

    beforeEach(() => {
      vi.mocked(llmProvidersApi.getById).mockResolvedValue(INACTIVE as any)
    })

    it('says it is inactive and why, from its last check', async () => {
      at()
      expect(await screen.findByTestId('provider-status')).toHaveTextContent('Inactive')
      const box = screen.getByTestId('provider-inactive')
      expect(within(box).getByRole('heading', { name: 'This connection is inactive' })).toBeInTheDocument()
      expect(within(box).getByTestId('provider-inactive-reason')).toHaveTextContent(/The last check \(.+\) failed: 401 Incorrect API key provided\. Replace the key if it was refused\. A passing check turns it back on\./)
      // The reason is said once, in the box, not again under it.
      expect(screen.queryByTestId('provider-last-error')).not.toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Check again' })).toHaveLength(1)
    })

    it('has one Check again, the one in the box, even when it lists no models', async () => {
      vi.mocked(modelsApi.list).mockResolvedValue([])
      at()
      expect(await screen.findByText('No models yet')).toBeInTheDocument()
      const buttons = screen.getAllByRole('button', { name: 'Check again' })
      expect(buttons).toHaveLength(1)
      expect(within(screen.getByTestId('provider-inactive')).getByRole('button', { name: 'Check again' })).toBe(buttons[0])
    })

    it('replaces the key right there, then checks again, and says it is active again', async () => {
      vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
      vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: true, reactivated: true } as any)
      vi.mocked(modelsApi.sync).mockResolvedValue({ created: [], skipped: [] } as any)
      at()
      const box = await screen.findByTestId('provider-inactive')
      fireEvent.click(within(box).getByRole('button', { name: 'Replace key' }))
      fireEvent.change(within(box).getByLabelText('New key'), { target: { value: 'sk-new-1234567890' } })
      fireEvent.click(within(box).getByRole('button', { name: 'Save and check' }))
      await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { credentialId: null, configuration: { apiKey: 'sk-new-1234567890' } }))
      await waitFor(() => expect(llmProvidersApi.test).toHaveBeenCalledWith('p1'))
      expect(await screen.findByTestId('provider-check-result')).toHaveTextContent('Key works. The connection is active again. 2 models.')
    })

    it('checks again from the box; a failing check leaves it inactive with the answer', async () => {
      vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: false, error: 'OpenAI rejected this key.' } as any)
      at()
      fireEvent.click(within(await screen.findByTestId('provider-inactive')).getByRole('button', { name: 'Check again' }))
      expect(await screen.findByTestId('provider-check-result')).toHaveTextContent('OpenAI rejected this key.')
      expect(screen.getByTestId('provider-inactive')).toBeInTheDocument()
    })

    it('says why, in words, for each way it went inactive', async () => {
      const { inactiveReason, canTurnBackOn } = await import('@/components/llm-providers/provider-status')
      const when = () => 'today'
      expect(inactiveReason({ inactiveReason: 'check_failed' }, when)).toBe('No check has run on it yet. A passing check turns it back on.')
      expect(inactiveReason({ inactiveReason: 'switched_off' }, when)).toBe('Someone turned it off on purpose, so a check does not turn it back on.')
      expect(inactiveReason({ inactiveReason: 'endpoint_stopped' }, when)).toBe('Its endpoint stopped serving. It comes back when the endpoint serves again.')
      expect(inactiveReason({}, when)).toBe('It was turned off, so a check does not turn it back on.')
      expect([canTurnBackOn({ inactiveReason: 'check_failed' }), canTurnBackOn({ inactiveReason: 'endpoint_stopped' }), canTurnBackOn({ inactiveReason: 'switched_off' })]).toEqual([false, false, true])
    })

    it('one switched off on purpose is turned back on by hand, not by a check', async () => {
      vi.mocked(llmProvidersApi.getById).mockResolvedValue({ ...INACTIVE, inactiveReason: 'switched_off' } as any)
      vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
      at()
      const box = await screen.findByTestId('provider-inactive')
      expect(within(box).getByTestId('provider-inactive-reason')).toHaveTextContent('Someone turned it off on purpose')
      fireEvent.click(within(box).getByRole('button', { name: 'Turn it back on' }))
      await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { status: 'active' }))
    })

    it('one a failed check turned off offers no switch: the check turns it back on', async () => {
      at()
      const box = await screen.findByTestId('provider-inactive')
      expect(within(box).queryByRole('button', { name: 'Turn it back on' })).not.toBeInTheDocument()
    })
  })

  describe('settings', () => {
    it('picks its default model among its own models only', async () => {
      at('settings')
      expect(await screen.findByTestId('default-model-picker')).toHaveAttribute('data-locked', 'true')
      expect(screen.getByTestId('default-model-picker')).toHaveAttribute('data-provider', 'p1')
    })

    it('replaces the key inline and checks it again', async () => {
      vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
      vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: true } as any)
      vi.mocked(modelsApi.sync).mockResolvedValue({ created: [], skipped: [] } as any)
      at('settings')
      fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
      fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'sk-new-1234567890' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save and check' }))
      await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { credentialId: null, configuration: { apiKey: 'sk-new-1234567890' } }))
      await waitFor(() => expect(llmProvidersApi.test).toHaveBeenCalledWith('p1'))
    })

    it('shows who can use it as one line until changed', async () => {
      vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
      at('settings')
      const line = await screen.findByTestId('who-can-use')
      expect(line).toHaveTextContent('Who can use it: Everyone')
      expect(screen.queryByRole('radio', { name: /^Only you/ })).not.toBeInTheDocument()
      fireEvent.click(within(line).getByRole('button', { name: 'Change' }))
      fireEvent.click(screen.getByRole('radio', { name: /^Only you/ }))
      await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', { visibility: 'private', teamId: null }))
    })

    it('keeps per-model settings and call settings under Advanced', async () => {
      vi.mocked(modelsApi.update).mockResolvedValue({} as any)
      at('settings')
      await screen.findByTestId('who-can-use')
      expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Context length')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
      expect(screen.getByLabelText('Temperature')).toBeInTheDocument()
      fireEvent.change(await screen.findByRole('combobox', { name: 'Model to change' }), { target: { value: 'card-o3' } })
      fireEvent.change(await screen.findByLabelText('Context length'), { target: { value: '200000' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(modelsApi.update).toHaveBeenCalledWith('card-o3', expect.objectContaining({ contextLength: 200000 })))
    })

    it('has no validate step and no dialogs besides the one-line remove confirmation', async () => {
      vi.mocked(llmProvidersApi.delete).mockResolvedValue({} as any)
      at('settings')
      await screen.findByTestId('who-can-use')
      expect(screen.queryByRole('button', { name: /Validate/ })).not.toBeInTheDocument()
      expect(screen.queryByText(/Validated|Not validated/)).not.toBeInTheDocument()

      vi.mocked(llmProvidersApi.agents).mockResolvedValue({ agents: [], others: 0 })
      fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }))
      const confirm = await screen.findByRole('alertdialog')
      expect(within(confirm).getByText('Remove OpenAI?')).toBeInTheDocument()
      expect(confirm).toHaveTextContent('No agent uses its models.')
      fireEvent.click(within(confirm).getByRole('button', { name: 'Remove connection' }))
      await waitFor(() => expect(llmProvidersApi.delete).toHaveBeenCalledWith('p1'))
      // Back to Credentials, where connections live.
      expect(await screen.findByText('at /credentials')).toBeInTheDocument()
    })

    it('names the agents that lose their model before removing, counting the ones the viewer cannot see', async () => {
      vi.mocked(llmProvidersApi.agents).mockResolvedValue({ agents: [{ id: 'a1', name: 'Support triage' }, { id: 'a2', name: 'Nightly digest' }], others: 1 })
      at('settings')
      await screen.findByTestId('who-can-use')
      fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }))
      const confirm = await screen.findByRole('alertdialog')
      expect(llmProvidersApi.agents).toHaveBeenCalledWith('p1')
      expect(confirm).toHaveTextContent('"Support triage", "Nightly digest" and 1 other agent use its models and stop working until given another model; their owners are told.')
      fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
      expect(llmProvidersApi.delete).not.toHaveBeenCalled()
    })

    it('reads the agents as a list', () => {
      expect(removeDescription(['Support triage'], 0)).toBe('Its key and its models go with it. "Support triage" uses its models and stops working until given another model; their owners are told.')
      expect(removeDescription(['A', 'B', 'C'], 0)).toContain('"A", "B" and "C" use its models')
      expect(removeDescription([], 2)).toContain('2 other agents use its models')
    })
  })

  it('offers no hosting on a provider that is not a cloud account', async () => {
    at('hosting')
    await screen.findByTestId('allowed-model-o3')
    expect(screen.queryByRole('tab', { name: /Open models on this account/ })).not.toBeInTheDocument()
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
      at('hosting')
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
      at('hosting')
      const panels = await screen.findAllByTestId('hosting-panel')
      expect(panels).toHaveLength(1)
      // Only this account's model; the Modal one belongs to another provider.
      expect(panels[0]).toHaveTextContent('Qwen/Qwen3-0.6B')
      expect(within(panels[0]).getByRole('button', { name: /Stop/ })).toBeInTheDocument()
    })
  })
})
