/**
 * /models/connect: pick a provider tile, name the connection, paste its
 * key, then untick any model it should not offer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { ConnectProviderPage } from '../models-connect'
import { llmProvidersApi } from '@/lib/api'
import { LlmProviderType } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: { connect: vi.fn(), providerTypes: vi.fn(), update: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

const at = (url = '/models/connect') =>
  renderAtRoute(<ConnectProviderPage />, { path: '/models/connect', url, paths: ['/models', '/models/providers/:id', '/guide'] })

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
  fireEvent.click(await screen.findByTestId(`provider-tile-${type}`))
  return screen.findByRole('form', { name: /^Connect / })
}

describe('ConnectProviderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([])
  })

  it('has a tile for every provider type', async () => {
    at()
    await screen.findByTestId('provider-tile-openai')
    const missing = Object.values(LlmProviderType).filter((t) => !screen.queryByTestId(`provider-tile-${t}`))
    expect(missing).toEqual([])
    expect(screen.getByTestId('provider-tile-custom')).toHaveTextContent(/Your own serverOpenAI-compatible$/)
  })

  it('searches the tiles', async () => {
    at()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search providers' }), { target: { value: 'anthro' } })
    expect(screen.getByTestId('provider-tile-anthropic')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-tile-openai')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search providers' }), { target: { value: 'zzzz' } })
    expect(screen.getByText(/No provider matches/)).toBeInTheDocument()
  })

  it('opens a tiny inline form for the tile, deep-linkable as ?type=', async () => {
    const { router } = at()
    const form = await openTile('openai')
    expect(router.state.location.search).toBe('?type=openai')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // A name, the key and who can use it; nothing about the model up front.
    expect(within(form).getByLabelText('Name')).toHaveValue('OpenAI')
    expect(within(form).getByLabelText('API key')).toBeInTheDocument()
    for (const label of [/model id/i, /^Model$/, /privacy/i, /^Region/, /context/i, /capabilit/i, /provider name/i, /provider type/i]) {
      expect(within(form).queryByLabelText(label)).not.toBeInTheDocument()
    }
    expect(within(form).getByTestId('who-can-use')).toHaveTextContent('Who can use it: everyone in your organization')
    expect(within(form).getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys')
    expect(within(form).getByRole('button', { name: /Connect an account/ })).toBeInTheDocument()
  })

  it('connects under the name given, org-wide by default, then lists every model found, all ticked', async () => {
    let resolve!: (v: unknown) => void
    vi.mocked(llmProvidersApi.connect).mockReturnValue(new Promise((r) => (resolve = r)))
    at('/models/connect?type=openai')
    const form = await screen.findByRole('form', { name: 'Connect OpenAI' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'OpenAI - research team' } })
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'sk-test-1234567890' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('button', { name: /Checking your key/ })).toBeDisabled()
    expect(llmProvidersApi.connect).toHaveBeenCalledWith({
      name: 'OpenAI - research team',
      type: 'openai',
      visibility: 'org',
      teamId: null,
      configuration: { apiKey: 'sk-test-1234567890' },
    })

    resolve({ provider: { id: 'p-new', name: 'OpenAI - research team', type: 'openai' }, models: MODELS, check: { ok: true } })
    const done = await screen.findByTestId('connect-success')
    expect(done).toHaveTextContent('OpenAI - research team is connected. 10 models found, all ticked.')
    expect(within(done).getByTestId('ticked-count')).toHaveTextContent('10 of 10 models ticked')
    // Nothing unticked: Done goes to the new connection without another request.
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /models/providers/p-new')).toBeInTheDocument()
    expect(llmProvidersApi.update).not.toHaveBeenCalled()
  })

  it('unticking models before Done keeps them out of that connection', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p-new', name: 'OpenAI', type: 'openai' }, models: MODELS.slice(0, 3), check: { ok: true } })
    vi.mocked(llmProvidersApi.update).mockResolvedValue({ id: 'p-new', name: 'OpenAI' } as any)
    at('/models/connect?type=openai')
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-test-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const done = await screen.findByTestId('connect-success')
    fireEvent.click(within(done).getByRole('checkbox', { name: 'Allow o3' }))
    expect(within(done).getByTestId('ticked-count')).toHaveTextContent('2 of 3 models ticked')
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p-new', { allowNewModels: true, hiddenModels: ['o3'], allowedModels: null }))
    expect(await screen.findByText('at /models/providers/p-new')).toBeInTheDocument()
  })

  it('goes back where it came from with ?returnTo, and only to this app', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p-new', name: 'OpenAI', type: 'openai' }, models: [], check: { ok: true } })
    at('/models/connect?type=openai&returnTo=%2Fguide')
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-test-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /guide')).toBeInTheDocument()
  })

  it('shows a refused key plainly next to the key, keeps the form filled and focuses the key', async () => {
    vi.mocked(llmProvidersApi.connect).mockRejectedValue({
      response: {
        status: 400,
        data: { success: false, error: 'KEY_REJECTED', message: 'OpenAI rejected this key.', detail: '401 Incorrect API key provided: sk-test***' },
      },
    })
    at('/models/connect?type=openai')
    const key = await screen.findByLabelText('API key')
    fireEvent.change(key, { target: { value: 'sk-test-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

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
    at('/models/connect?type=anthropic')
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-ant-1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const failure = await screen.findByTestId('connect-failure')
    expect(failure).toHaveTextContent('Could not reach almyty')
    expect(failure).toHaveTextContent('Network Error')
  })

  it('asks for the key before sending anything', async () => {
    at('/models/connect?type=openai')
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
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
    at(`/models/connect?type=${type}`)
    const form = await screen.findByRole('form', { name: /^Connect / })
    for (const label of labels) expect(within(form).getByLabelText(label)).toBeInTheDocument()
  })

  it('asks nothing extra of a provider that needs only a key', async () => {
    at('/models/connect?type=anthropic')
    const form = await screen.findByRole('form', { name: /^Connect / })
    for (const label of ['AWS region', 'Resource name', 'Model name in Azure', 'Google Cloud project ID', 'Endpoint', 'Model', 'Server URL']) {
      expect(within(form).queryByLabelText(label)).not.toBeInTheDocument()
    }
  })

  it('sends the region Bedrock needs, nested the way the provider reads it', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'AWS Bedrock', type: 'aws_bedrock' }, models: [] })
    at('/models/connect?type=aws_bedrock')
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('AWS region is required')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('AWS region'), { target: { value: 'eu-central-1' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'bedrock-key-123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'aws_bedrock', configuration: { apiKey: 'bedrock-key-123456', bedrock: { region: 'eu-central-1' } } })
  })

  it('takes a server URL and an optional key for your own server', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'My server', type: 'custom' }, models: [] })
    at('/models/connect?type=custom')
    const form = await screen.findByRole('form', { name: /^Connect / })
    expect(within(form).getByLabelText('API key (optional)')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/Enter the server URL/)).toBeInTheDocument()
    fireEvent.change(within(form).getByLabelText('Server URL'), { target: { value: 'http://gpu-box:8000/v1' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ name: 'My server', type: 'custom', configuration: { apiUrl: 'http://gpu-box:8000/v1' } })
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0].configuration).not.toHaveProperty('apiKey')
  })

  it('asks Ollama for an Ollama Cloud key by default, and sends it with ollama.com', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'Ollama', type: 'ollama' }, models: [] })
    at('/models/connect?type=ollama')
    const form = await screen.findByRole('form', { name: /^Connect / })
    expect(within(form).getByTestId('connect-ollama-cloud')).toHaveAttribute('aria-pressed', 'true')
    expect(within(form).queryByLabelText('Server URL')).not.toBeInTheDocument()
    expect(within(form).getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://ollama.com/settings/keys')
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('Paste your Ollama Cloud API key')).toBeInTheDocument()
    expect(llmProvidersApi.connect).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('Ollama Cloud API key'), { target: { value: 'ollama-key-1234567890' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'ollama', configuration: { apiKey: 'ollama-key-1234567890', apiUrl: 'https://ollama.com' } })
  })

  it('takes the URL of an Ollama you run instead, with the key optional', async () => {
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'Ollama', type: 'ollama' }, models: [] })
    at('/models/connect?type=ollama')
    const form = await screen.findByRole('form', { name: /^Connect / })
    fireEvent.click(within(form).getByTestId('connect-ollama-own'))
    expect(within(form).getByLabelText('API key (optional)')).toBeInTheDocument()
    expect(within(form).getByText(/OLLAMA_ALLOW_PRIVATE_URLS=true/)).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/Enter the server URL/)).toBeInTheDocument()
    fireEvent.change(within(form).getByLabelText('Server URL'), { target: { value: 'http://build-box:11434' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }))
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
      at('/models/connect?type=qwen')
      const form = await screen.findByRole('form', { name: /^Connect / })
      expect(await within(form).findByLabelText('Model')).toBeInTheDocument()
      expect(within(form).getByText(/does not list its models/)).toBeInTheDocument()
      expect(llmProvidersApi.providerTypes).toHaveBeenCalled()
    })

    it('does not ask openai for a model', async () => {
      vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([{ type: 'openai', listsModels: true }] as any)
      at('/models/connect?type=openai')
      const form = await screen.findByRole('form', { name: /^Connect / })
      await waitFor(() => expect(llmProvidersApi.providerTypes).toHaveBeenCalled())
      expect(within(form).queryByLabelText('Model')).not.toBeInTheDocument()
    })

    it('follows provider-types over the built-in list', async () => {
      // The server is the source of truth: a type it says lists nothing gets the field.
      vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([{ type: 'openai', listsModels: false }] as any)
      at('/models/connect?type=openai')
      expect(await screen.findByLabelText('Model')).toBeInTheDocument()
    })

    it('still asks before provider-types has answered', async () => {
      vi.mocked(llmProvidersApi.providerTypes).mockReturnValue(new Promise(() => {}))
      at('/models/connect?type=fireworks')
      expect(await screen.findByLabelText('Model')).toBeInTheDocument()
    })

    it('requires the model, and sends it as configuration.model', async () => {
      vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p', name: 'Qwen', type: 'qwen' }, models: [] })
      at('/models/connect?type=qwen')
      fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-qwen-1234567890' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      expect(await screen.findByText('Enter the model you want to use')).toBeInTheDocument()
      expect(llmProvidersApi.connect).not.toHaveBeenCalled()

      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'qwen3-max' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
      expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'qwen', configuration: { apiKey: 'sk-qwen-1234567890', model: 'qwen3-max' } })
    })

    it('puts MODEL_REQUIRED next to the model field and the cursor in it', async () => {
      vi.mocked(llmProvidersApi.providerTypes).mockResolvedValue([{ type: 'openai', listsModels: true }] as any)
      vi.mocked(llmProvidersApi.connect).mockRejectedValue({
        response: { status: 400, data: { success: false, error: 'MODEL_REQUIRED', message: 'OpenAI does not list its models. Enter the model you want to use.' } },
      })
      at('/models/connect?type=openai')
      const key = await screen.findByLabelText('API key')
      fireEvent.change(key, { target: { value: 'sk-test-1234567890' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      expect(await screen.findByText('OpenAI does not list its models. Enter the model you want to use.')).toBeInTheDocument()
      const model = screen.getByLabelText('Model')
      await waitFor(() => expect(model).toHaveFocus())
      // It is about the model, not the key.
      expect(screen.queryByTestId('connect-failure')).not.toBeInTheDocument()
      expect(key).toHaveValue('sk-test-1234567890')
    })
  })
})
