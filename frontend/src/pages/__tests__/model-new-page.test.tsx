import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { ModelNewPage } from '../model-new'
import { buildServerRequests } from '@/components/models/server-model-form'
import { modelsApi } from '../../lib/models-api'
import { llmProvidersApi } from '../../lib/api'
import { modelAdaptersApi, modelDeploymentsApi } from '../../lib/deployments-api'
import { hfAdapter } from '@/components/models/hosting/__tests__/fixtures'

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
  }
})

vi.mock('../../lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn(), getModels: vi.fn(), create: vi.fn(), testConnection: vi.fn() },
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
  budgetsApi: { list: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../lib/connections-api', () => ({
  connectionsApi: { list: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('../../store/app', () => ({
  useNotifications: () => notify,
}))

// The step lives in the URL (?via=), so Back works and each step is linkable.
const searchParams = { current: new URLSearchParams() }
const setSearchParams = vi.fn((next: URLSearchParams) => { searchParams.current = next })
const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useSearchParams: () => [searchParams.current, setSearchParams],
    useNavigate: () => navigate,
  }
})

function renderPage(via?: string) {
  searchParams.current = new URLSearchParams(via ? `via=${via}` : '')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<ModelNewPage />, { queryClient })
}

describe('buildServerRequests', () => {
  it('makes a server you run a custom inference provider plus an ordinary model', () => {
    const { provider, model } = buildServerRequests({ name: 'Office box', url: 'http://10.0.0.5:8000/v1', apiKey: 'sk-local-123', vendorModelId: 'qwen3-14b', privacyTier: 'local' })
    expect(provider).toEqual({ name: 'Office box', type: 'custom', configuration: { apiUrl: 'http://10.0.0.5:8000/v1', model: 'qwen3-14b', apiKey: 'sk-local-123' } })
    expect(model).toEqual({ name: 'Office box', vendorModelId: 'qwen3-14b', privacyTier: 'local' })
  })

  it('sends a connected account instead of a pasted key, and nothing for a keyless server', () => {
    const connected = buildServerRequests({ name: 'b', url: 'http://h/v1', apiKey: 'typed', connectionId: 'conn-1', vendorModelId: 'm', privacyTier: 'local' })
    expect(connected.provider.credentialId).toBe('conn-1')
    expect(connected.provider.configuration).not.toHaveProperty('apiKey')
    const keyless = buildServerRequests({ name: 'b', url: 'http://h/v1', vendorModelId: 'm', privacyTier: 'local' })
    expect(keyless.provider).not.toHaveProperty('credentialId')
    expect(keyless.provider.configuration).not.toHaveProperty('apiKey')
  })
})

describe('ModelNewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Radix Select needs these in jsdom to open its listbox.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([])
    vi.mocked(llmProvidersApi.getModels).mockResolvedValue([])
    vi.mocked(modelAdaptersApi.list).mockResolvedValue([hfAdapter])
  })

  it('asks where the model runs first, on the page, in three plain answers, without the word deployment', async () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Add model' })).toBeInTheDocument()
    expect(screen.getByText('Where does it run?')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toMatch(/deploy|tracked artifact|register endpoint/i)

    await userEvent.click(screen.getByRole('button', { name: /Your cloud account/ }))
    // The answer goes into the URL, so Back returns to this question.
    expect(setSearchParams).toHaveBeenCalled()
    expect(searchParams.current.get('via')).toBe('cloud')
  })

  it('does not dead-end with no inference providers: it sets one up inline, and shows no empty dropdown', async () => {
    renderPage('provider')
    expect(await screen.findByTestId('no-inference-providers')).toBeInTheDocument()
    // The old form rendered an empty select (the stray bar) and a disabled submit.
    expect(screen.queryByRole('combobox', { name: 'Inference provider' })).not.toBeInTheDocument()
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Set up an inference provider/ }))
    expect(await screen.findByRole('heading', { name: 'Set up an inference provider' })).toBeInTheDocument()
    expect(screen.getByLabelText('Provider Name')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('hides the provider rows the reconcile loop writes for hosted models', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([
      { id: 'p1', name: 'Anthropic prod', type: 'anthropic' },
      { id: 'pm', name: 'Support bot', type: 'openai', metadata: { managedBy: { kind: 'model_endpoint', id: 'd-1' } } },
    ] as any)
    renderPage('provider')
    await userEvent.click(await screen.findByRole('combobox', { name: 'Inference provider' }))
    expect(await screen.findByRole('option', { name: /Anthropic prod/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Support bot/ })).not.toBeInTheDocument()
  })

  it("adds a model from a provider's API and opens it", async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([{ id: 'p1', name: 'Anthropic prod', type: 'anthropic' }] as any)
    vi.mocked(modelsApi.register).mockResolvedValue({ id: 'c1', name: 'claude-sonnet-5' } as any)
    renderPage('provider')

    await userEvent.click(await screen.findByRole('combobox', { name: 'Inference provider' }))
    await userEvent.click(await screen.findByRole('option', { name: /Anthropic prod/ }))
    await userEvent.type(screen.getByLabelText('Model'), 'claude-sonnet-5')
    fireEvent.blur(screen.getByLabelText('Model'))
    await userEvent.click(screen.getByRole('button', { name: 'Add model' }))

    await waitFor(() => expect(modelsApi.register).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p1', vendorModelId: 'claude-sonnet-5', name: 'claude-sonnet-5' })))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/models/c1'))
  })

  it('connects a server you run as a custom inference provider, then adds its model', async () => {
    vi.mocked(llmProvidersApi.create).mockResolvedValue({ id: 'p-box', name: 'Office box', type: 'custom' })
    vi.mocked(modelsApi.register).mockResolvedValue({ id: 'c-box', name: 'Office box' } as any)
    renderPage('server')

    await userEvent.type(screen.getByLabelText('Base URL'), 'http://10.0.0.5:8000/v1')
    await userEvent.type(screen.getByLabelText('Model id'), 'qwen3-14b')
    await userEvent.type(screen.getByLabelText('Name'), 'Office box')
    await userEvent.click(screen.getByRole('button', { name: 'Add model' }))

    await waitFor(() =>
      expect(llmProvidersApi.create).toHaveBeenCalledWith({ name: 'Office box', type: 'custom', configuration: { apiUrl: 'http://10.0.0.5:8000/v1', model: 'qwen3-14b' } }),
    )
    await waitFor(() => expect(modelsApi.register).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p-box', vendorModelId: 'qwen3-14b', privacyTier: 'private_cloud' })))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/models/c-box'))
  })

  it('treats a model the provider import already created as success', async () => {
    vi.mocked(llmProvidersApi.create).mockResolvedValue({ id: 'p-box', name: 'Office box', type: 'custom' })
    vi.mocked(modelsApi.register).mockRejectedValue({ response: { data: { error: { code: 'MODEL_EXISTS', message: 'exists' } } } })
    renderPage('server')

    await userEvent.type(screen.getByLabelText('Base URL'), 'http://10.0.0.5:8000/v1')
    await userEvent.type(screen.getByLabelText('Model id'), 'qwen3-14b')
    await userEvent.type(screen.getByLabelText('Name'), 'Office box')
    await userEvent.click(screen.getByRole('button', { name: 'Add model' }))

    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Server connected', expect.any(String)))
    expect(notify.error).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/models')
  })

  it('never calls the removed register-endpoint route', async () => {
    vi.mocked(llmProvidersApi.create).mockResolvedValue({ id: 'p-box', name: 'b', type: 'custom' })
    vi.mocked(modelsApi.register).mockResolvedValue({ id: 'c', name: 'b' } as any)
    renderPage('server')
    await userEvent.type(screen.getByLabelText('Base URL'), 'http://h:8000/v1')
    await userEvent.type(screen.getByLabelText('Model id'), 'm')
    await userEvent.type(screen.getByLabelText('Name'), 'b')
    await userEvent.click(screen.getByRole('button', { name: 'Add model' }))
    await waitFor(() => expect(modelsApi.register).toHaveBeenCalled())
    expect((modelsApi as Record<string, unknown>).registerEndpoint).toBeUndefined()
  })

  it('hosts a model on your cloud from a repository name alone, and opens the model it created', async () => {
    vi.mocked(modelDeploymentsApi.create).mockResolvedValue({ id: 'd-1', modelId: 'h1' } as any)
    renderPage('cloud')

    fireEvent.change(await screen.findByLabelText('Which model'), { target: { value: 'hf://Qwen/Qwen3-14B' } })
    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Inference Endpoints/ }))
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_live_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Host model' }))

    await waitFor(() =>
      expect(modelDeploymentsApi.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'hf://Qwen/Qwen3-14B', providerType: 'huggingface-endpoints' })),
    )
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/models/h1'))
  })

  it('goes back to the first question', async () => {
    renderPage('server')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(navigate).toHaveBeenCalledWith('/models/new')
  })
})
