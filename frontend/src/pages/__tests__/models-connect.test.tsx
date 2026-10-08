/**
 * /models/providers/new: pick a provider tile, name the connection, paste its
 * key, then untick any model it should not offer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { ConnectProviderPage } from '../models-connect'
import { llmProvidersApi } from '@/lib/api'
import { connectionsApi } from '@/lib/connections-api'
import { LlmProviderType } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/connections-api', () => ({ connectionsApi: { list: vi.fn().mockResolvedValue([]) }, connectorsApi: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: { connect: vi.fn(), providerTypes: vi.fn(), update: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

const at = (url = '/models/providers/new') =>
  renderAtRoute(<ConnectProviderPage />, { path: '/models/providers/new', url, paths: ['/models', '/credentials', '/models/providers/:id', '/guide'] })

const MODELS = ['gpt-4o', 'gpt-4.1', 'o3', 'o4-mini', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3-pro', 'gpt-image-1'].map((id) => ({
  id: `card-${id}`,
  name: id,
  vendorModelId: id,
  selectable: true,
  status: 'active',
  validationStatus: 'passed',
  pricing: null,
  pricingOverride: null,
  contextLength: null,
  metadata: null,
}))

async function openTile(type: string) {
  fireEvent.click(await screen.findByTestId('service-select-trigger'))
  fireEvent.click(screen.getByTestId(`service-select-option-model:${type}`))
  return screen.findByTestId('credential-form')
}

describe('ConnectProviderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([])
  })

  it('offers every provider in one select, without tiles or headings', async () => {
    at()
    fireEvent.click(await screen.findByTestId('service-select-trigger'))
    expect(screen.getAllByRole('option')).toHaveLength(Object.values(LlmProviderType).length)
    expect(screen.queryByTestId('provider-tile-openai')).not.toBeInTheDocument()
    expect(screen.queryByText('Model providers')).not.toBeInTheDocument()
  })

  it('searches the provider list', async () => {
    at()
    fireEvent.click(await screen.findByTestId('service-select-trigger'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search providers' }), { target: { value: 'anthro' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Anthropic')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search providers' }), { target: { value: 'zzzz' } })
    expect(screen.getByText(/No provider matches/)).toBeInTheDocument()
  })

  it('uses the one form, with a deep-linked provider and no dialog', async () => {
    const { router } = at()
    const form = await openTile('openai')
    expect(router.state.location.search).toBe('?type=openai')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(form).getByLabelText('Name')).toHaveValue('OpenAI')
    expect(within(form).getByLabelText('API key')).toBeInTheDocument()
    expect(within(form).getByTestId('who-can-use')).toHaveTextContent('Who can use it: Everyone')
  })

  it('connects with a key already in Credentials, picked with the shared credential picker', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([
      { id: 'cred-anthropic', name: 'Anthropic team', connectorKey: 'anthropic', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'cred-openai', name: 'OpenAI billing', connectorKey: 'openai', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '2026-09-01T00:00:00.000Z' },
    ] as any)
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p-new', name: 'OpenAI', type: 'openai' }, models: [], check: { ok: true } })
    at('/models/providers/new?type=openai')
    const form = await screen.findByTestId('credential-form')
    fireEvent.click(within(form).getByRole('button', { name: 'Use a saved key instead' }))
    expect(within(form).queryByLabelText('API key')).not.toBeInTheDocument()
    // Nothing picked yet: it says so instead of sending an empty key.
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await within(form).findByText('Pick a saved key, or paste one instead')).toBeInTheDocument()
    expect(llmProvidersApi.connect).not.toHaveBeenCalled()

    fireEvent.click(within(form).getByRole('combobox', { name: 'Saved key' }))
    const options = await screen.findAllByRole('option')
    expect(options[0]).toHaveTextContent('OpenAI billing')
    fireEvent.click(options[0])
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalledWith(expect.objectContaining({ type: 'openai', credentialId: 'cred-openai' })))
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0].configuration?.apiKey).toBeUndefined()
  })

  it('saves the named provider and opens its Models connection directly', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p-new', name: 'Research', type: 'openai' }, models: MODELS })
    const { router } = at('/models/providers/new?type=openai')
    const form = await screen.findByTestId('credential-form')
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Research' } })
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'sk-test-1234567890' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/models/providers/p-new'))
    expect(llmProvidersApi.connect).toHaveBeenCalledWith({ name: 'Research', type: 'openai', visibility: 'org', teamId: null, configuration: { apiKey: 'sk-test-1234567890' } })
    expect(llmProvidersApi.update).not.toHaveBeenCalled()
  })

  it('goes back where it came from with ?returnTo, and only to this app', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p-new', name: 'OpenAI', type: 'openai' }, models: [], check: { ok: true } })
    at('/models/providers/new?type=openai&returnTo=%2Fguide')
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-test-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('at /guide')).toBeInTheDocument()
  })

  it('shows a refused key plainly next to the key, keeps the form filled and focuses the key', async () => {
    vi.mocked(llmProvidersApi.connect).mockRejectedValue({
      response: {
        status: 400,
        data: { success: false, error: 'KEY_REJECTED', message: 'OpenAI rejected this key.', detail: '401 Incorrect API key provided: sk-test***' },
      },
    })
    at('/models/providers/new?type=openai')
    const key = await screen.findByLabelText('API key')
    fireEvent.change(key, { target: { value: 'sk-test-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const failure = await screen.findByTestId('connect-failure')
    expect(failure).toHaveTextContent('OpenAI rejected this key.')
    // The vendor's own words are one click away, not the headline.
    expect(within(failure).getByText('Details')).toBeInTheDocument()
    expect(within(failure).getByText(/401 Incorrect API key/)).toBeInTheDocument()
    expect(key).toHaveValue('sk-test-1234567890')
    await waitFor(() => expect(key).toHaveFocus())
    expect(screen.getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys')
    expect(screen.queryByTestId('connect-success')).not.toBeInTheDocument()
  })

  it('says a network problem is not the key', async () => {
    vi.mocked(llmProvidersApi.connect).mockRejectedValue(new Error('Network Error'))
    at('/models/providers/new?type=anthropic')
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-ant-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const failure = await screen.findByTestId('connect-failure')
    expect(failure).toHaveTextContent('Could not reach almyty')
    expect(failure).toHaveTextContent('Network Error')
  })

  it('asks for the key before sending anything', async () => {
    at('/models/providers/new?type=openai')
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Paste your API key')).toBeInTheDocument()
    expect(llmProvidersApi.connect).not.toHaveBeenCalled()
  })

  it.each([
    ['aws_bedrock', ['AWS region']],
    ['azure_openai', ['Resource name', 'Model name in Azure']],
    ['azure_ai_foundry', ['Resource name', 'Model name in Azure']],
    ['vertex_ai', ['Google Cloud project ID', 'Location (optional)', 'Model']],
    ['runpod', ['Endpoint']],
  ])('asks %s for exactly what it cannot work without', async (type, labels) => {
    at(`/models/providers/new?type=${type}`)
    const form = await screen.findByTestId('credential-form')
    for (const label of labels) expect(within(form).getByLabelText(label)).toBeInTheDocument()
  })

  it('asks nothing extra of a provider that needs only a key', async () => {
    at('/models/providers/new?type=anthropic')
    const form = await screen.findByTestId('credential-form')
    for (const label of ['AWS region', 'Resource name', 'Model name in Azure', 'Google Cloud project ID', 'Endpoint', 'Model', 'Server URL']) {
      expect(within(form).queryByLabelText(label)).not.toBeInTheDocument()
    }
  })

  it('sends the region Bedrock needs, nested the way the provider reads it', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'AWS Bedrock', type: 'aws_bedrock' }, models: [] })
    at('/models/providers/new?type=aws_bedrock')
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('AWS region is required')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('AWS region'), { target: { value: 'eu-central-1' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'bedrock-key-123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'aws_bedrock', configuration: { apiKey: 'bedrock-key-123456', bedrock: { region: 'eu-central-1' } } })
  })

  it('takes a server URL and an optional key for your own server', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'My server', type: 'custom' }, models: [] })
    at('/models/providers/new?type=custom')
    const form = await screen.findByTestId('credential-form')
    expect(within(form).getByLabelText('API key (optional)')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Enter the server URL/)).toBeInTheDocument()
    fireEvent.change(within(form).getByLabelText('Server URL'), { target: { value: 'http://gpu-box:8000/v1' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ name: 'Your own server (OpenAI-compatible)', type: 'custom', configuration: { apiUrl: 'http://gpu-box:8000/v1' } })
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0].configuration).not.toHaveProperty('apiKey')
  })

  it('asks Ollama for an Ollama Cloud key by default, and sends it with ollama.com', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'Ollama', type: 'ollama' }, models: [] })
    at('/models/providers/new?type=ollama')
    const form = await screen.findByTestId('credential-form')
    expect(await within(form).findByRole('combobox', { name: 'Where Ollama runs' })).toHaveTextContent('Ollama Cloud')
    expect(within(form).queryByLabelText('Server URL')).not.toBeInTheDocument()
    expect(within(form).getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://ollama.com/settings/keys')
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Paste your Ollama Cloud API key')).toBeInTheDocument()
    expect(llmProvidersApi.connect).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('Ollama Cloud API key'), { target: { value: 'ollama-key-1234567890' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'ollama', configuration: { apiKey: 'ollama-key-1234567890', apiUrl: 'https://ollama.com' } })
  })

  it('takes the URL of an Ollama you run instead, with the key optional', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'Ollama', type: 'ollama' }, models: [] })
    at('/models/providers/new?type=ollama')
    const form = await screen.findByTestId('credential-form')
    fireEvent.click(await within(form).findByRole('combobox', { name: 'Where Ollama runs' }))
    fireEvent.click(screen.getByRole('option', { name: /Your own server/ }))
    expect(within(form).getByLabelText('API key (optional)')).toBeInTheDocument()
    expect(within(form).getByText('The address of your model server, reachable from almyty.')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Enter the server URL/)).toBeInTheDocument()
    fireEvent.change(within(form).getByLabelText('Server URL'), { target: { value: 'http://build-box:11434' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'ollama', configuration: { apiUrl: 'http://build-box:11434' } })
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0].configuration).not.toHaveProperty('apiKey')
  })

  describe('providers that list no models', () => {
    it('asks qwen for the model to use, and openai not, as provider-types says', async () => {
      vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([
        { type: 'qwen', listsModels: false },
        { type: 'openai', listsModels: true },
      ] as any)
      at('/models/providers/new?type=qwen')
      const form = await screen.findByTestId('credential-form')
      expect(await within(form).findByLabelText('Model')).toBeInTheDocument()
      expect(within(form).getByText(/does not list its models/)).toBeInTheDocument()
      expect(llmProvidersApi.providerTypes).toHaveBeenCalled()
    })

    it('does not ask openai for a model', async () => {
      vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([{ type: 'openai', listsModels: true }] as any)
      at('/models/providers/new?type=openai')
      const form = await screen.findByTestId('credential-form')
      await waitFor(() => expect(llmProvidersApi.providerTypes).toHaveBeenCalled())
      expect(within(form).queryByLabelText('Model')).not.toBeInTheDocument()
    })

    it('follows provider-types over the built-in list', async () => {
      // The server is the source of truth: a type it says lists nothing gets the field.
      vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([{ type: 'openai', listsModels: false }] as any)
      at('/models/providers/new?type=openai')
      expect(await screen.findByLabelText('Model')).toBeInTheDocument()
    })

    it('still asks before provider-types has answered', async () => {
      vi.mocked(llmProvidersApi.providerTypes).mockReturnValue(new Promise(() => {}))
      at('/models/providers/new?type=fireworks')
      expect(await screen.findByLabelText('Model')).toBeInTheDocument()
    })

    it('requires the model, and sends it as configuration.model', async () => {
      vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'Qwen', type: 'qwen' }, models: [] })
      at('/models/providers/new?type=qwen')
      fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-qwen-1234567890' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(await screen.findByText('Enter the model you want to use')).toBeInTheDocument()
      expect(llmProvidersApi.connect).not.toHaveBeenCalled()

      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'qwen3-max' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
      expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'qwen', configuration: { apiKey: 'sk-qwen-1234567890', model: 'qwen3-max' } })
    })

    it('puts MODEL_REQUIRED next to the model field and the cursor in it', async () => {
      vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([{ type: 'openai', listsModels: true }] as any)
      vi.mocked(llmProvidersApi.connect).mockRejectedValue({
        response: { status: 400, data: { success: false, error: 'MODEL_REQUIRED', message: 'OpenAI does not list its models. Enter the model you want to use.' } },
      })
      at('/models/providers/new?type=openai')
      const key = await screen.findByLabelText('API key')
      fireEvent.change(key, { target: { value: 'sk-test-1234567890' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      expect(await screen.findByText('OpenAI does not list its models. Enter the model you want to use.')).toBeInTheDocument()
      const model = screen.getByLabelText('Model')
      await waitFor(() => expect(model).toHaveFocus())
      // It is about the model, not the key.
      expect(screen.queryByTestId('connect-failure')).not.toBeInTheDocument()
      expect(key).toHaveValue('sk-test-1234567890')
    })
  })
})
