/**
 * /models: the providers you connected, and every model they offer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { ModelsPage } from '../models'
import { llmProvidersApi } from '@/lib/api'
import { modelsApi } from '@/lib/models-api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({ llmProvidersApi: { getAll: vi.fn() } }))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn() } }))
vi.mock('@/components/onboarding/page-intro', () => ({ PageIntro: () => null }))

// Radix Select does not open in jsdom; a native <select> keeps what is under
// test (the options and what a choice does) and takes the trigger's label.
vi.mock('@/components/ui/select', async () => {
  const R = await import('react')
  const textOf = (node: any): string =>
    node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.props?.children)
  const SelectTrigger = () => null
  return {
    Select: ({ value, onValueChange, children }: any) => {
      const trigger = R.Children.toArray(children).find((c: any) => c?.type === SelectTrigger) as any
      return R.createElement('select', { value, 'aria-label': trigger?.props['aria-label'], onChange: (e: any) => onValueChange?.(e.target.value) }, children)
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => R.createElement(R.Fragment, null, children),
    SelectItem: ({ value, children }: any) => R.createElement('option', { value }, textOf(children)),
  }
})

const NOW = '2026-09-25T10:00:00.000Z'
const OPENAI = { id: 'prov-openai', name: 'OpenAI', type: 'openai', status: 'active', lastSuccessAt: NOW, keyChecked: true }
const ANTHROPIC = { id: 'prov-anthropic', name: 'Anthropic', type: 'anthropic', status: 'active', lastSuccessAt: NOW, keyChecked: true }
const GROQ = { id: 'prov-groq', name: 'Groq', type: 'groq', status: 'error', lastError: 'Request failed with status code 401', lastErrorAt: NOW }

function card(providerId: string, vendorModelId: string, over: Record<string, any> = {}) {
  return {
    id: `card-${vendorModelId}`,
    name: vendorModelId,
    vendorModelId,
    providerId,
    status: 'active',
    selectable: true,
    validationStatus: 'passed',
    lastValidationError: null,
    pricing: null,
    pricingOverride: null,
    contextLength: null,
    metadata: null,
    ...over,
  } as any
}

const CARDS = [
  card(OPENAI.id, 'gpt-4o', { pricing: { inPerMTok: 2.5, outPerMTok: 10 }, contextLength: 128000 }),
  // Your own price wins over the provider's.
  card(OPENAI.id, 'o3', { pricing: { inPerMTok: 10, outPerMTok: 40 }, pricingOverride: { inPerMTok: 1, outPerMTok: 4 }, contextLength: 1_000_000 }),
  card(OPENAI.id, 'gpt-3.5-turbo', { selectable: false, status: 'inactive', metadata: { retiredReason: 'No longer listed by OpenAI' } }),
  card(ANTHROPIC.id, 'claude-sonnet-5', { name: 'Claude Sonnet 5', selectable: false, status: 'error', validationStatus: 'failed', lastValidationError: 'model: claude-sonnet-5 not found' }),
  card(GROQ.id, 'llama-4', { selectable: false }),
]

const at = () => renderAtRoute(<ModelsPage />, { path: '/models', paths: ['/models/connect', '/models/providers/:id'] })

describe('ModelsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, ANTHROPIC, GROQ] as any)
    vi.mocked(modelsApi.list).mockResolvedValue(CARDS)
  })

  it('shows each connected provider with its key status and number of models, opening its page', async () => {
    at()
    const openai = await screen.findByTestId('provider-card-prov-openai')
    expect(openai).toHaveAttribute('href', '/models/providers/prov-openai')
    expect(await within(openai).findByText('3 models')).toBeInTheDocument()
    expect(within(openai).getByTestId('provider-status')).toHaveTextContent('Key works')
    expect(within(screen.getByTestId('provider-card-prov-anthropic')).getByText('1 model')).toBeInTheDocument()
    expect(within(screen.getByTestId('provider-card-prov-groq')).getByTestId('provider-status')).toHaveTextContent('Key rejected')
  })

  it('has one primary action: connect a provider', async () => {
    at()
    const link = await screen.findByRole('link', { name: /Connect a provider/ })
    expect(link).toHaveAttribute('href', '/models/connect')
    expect(screen.queryByRole('link', { name: /Add model/ })).not.toBeInTheDocument()
  })

  it('lists every model grouped by provider, with price per 1M, context and availability', async () => {
    at()
    const gpt4o = await screen.findByTestId('model-row-card-gpt-4o')
    expect(within(gpt4o).getByTestId('model-price')).toHaveTextContent('$2.50 in / $10.00 out')
    expect(within(gpt4o).getByTestId('model-price')).toHaveTextContent('per 1M tokens')
    expect(within(gpt4o).getByTestId('model-context')).toHaveTextContent('128k')
    expect(within(gpt4o).getByTestId('model-availability')).toHaveTextContent('Available')

    const o3 = screen.getByTestId('model-row-card-o3')
    expect(within(o3).getByTestId('model-price')).toHaveTextContent('$1.00 in / $4.00 out')
    expect(within(o3).getByTestId('model-context')).toHaveTextContent('1M')

    expect(within(screen.getByTestId('model-group-prov-openai')).getAllByRole('listitem')).toHaveLength(3)
  })

  it('says in a few words why a model cannot be used', async () => {
    at()
    const retired = await screen.findByTestId('model-row-card-gpt-3.5-turbo')
    expect(within(retired).getByTestId('model-availability')).toHaveTextContent('No longer offered')

    const failed = screen.getByTestId('model-row-card-claude-sonnet-5')
    const badge = within(failed).getByTestId('model-availability')
    expect(badge).toHaveTextContent('Not available')
    // The provider's own words, on hover and under the row.
    expect(badge).toHaveAttribute('title', 'model: claude-sonnet-5 not found')
    expect(within(failed).getByTestId('model-unavailable-detail')).toHaveTextContent('model: claude-sonnet-5 not found')

    expect(within(screen.getByTestId('model-row-card-llama-4')).getByTestId('model-availability')).toHaveTextContent('Provider check failed')
  })

  it('searches the models', async () => {
    at()
    await screen.findByTestId('model-row-card-gpt-4o')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'sonnet' } })
    expect(screen.getByTestId('model-row-card-claude-sonnet-5')).toBeInTheDocument()
    expect(screen.queryByTestId('model-row-card-gpt-4o')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-group-prov-openai')).not.toBeInTheDocument()
  })

  it('says "Key works" only by the rule that makes the models usable, never over a failed check', async () => {
    // A check ran and failed: the old page read lastHealthCheckAt as proof.
    const MISTRAL = { id: 'prov-mistral', name: 'Mistral', type: 'mistral', status: 'active', isHealthy: false, lastHealthCheckAt: NOW, lastError: 'connect ETIMEDOUT', keyChecked: false }
    // Real traffic went through, but the key check never ran.
    const GEMINI = { id: 'prov-gemini', name: 'Gemini', type: 'google', status: 'active', lastSuccessAt: NOW, keyChecked: false }
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, MISTRAL, GEMINI] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(OPENAI.id, 'gpt-4o'),
      card(MISTRAL.id, 'mistral-large', { selectable: false, validationStatus: 'never' }),
      card(GEMINI.id, 'gemini-2.5-flash', { selectable: false, validationStatus: 'never' }),
    ])
    at()
    const status = async (id: string) => within(await screen.findByTestId(`provider-card-${id}`)).getByTestId('provider-status')
    expect(await status('prov-openai')).toHaveTextContent('Key works')
    expect(await status('prov-mistral')).toHaveTextContent('Check failed')
    expect(await status('prov-gemini')).toHaveTextContent('Not checked yet')
    expect(within(await screen.findByTestId('model-row-card-mistral-large')).getByTestId('model-availability')).toHaveTextContent('Provider check failed')
  })

  it('shows an unknown price as unknown, a free model as free, and no context when unknown', async () => {
    const OLLAMA = { id: 'prov-ollama', name: 'Ollama box', type: 'ollama', status: 'active', keyChecked: true }
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, OLLAMA] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(OPENAI.id, 'gpt-image-2'),
      card(OLLAMA.id, 'llama3.2', { pricing: { inPerMTok: 0, outPerMTok: 0, currency: 'USD' } }),
    ])
    at()
    const unknown = await screen.findByTestId('model-row-card-gpt-image-2')
    expect(within(unknown).getByTestId('model-price')).toHaveTextContent(/^Price unknown$/)
    expect(within(unknown).getByTestId('model-context')).toHaveTextContent(/^$/)
    const free = screen.getByTestId('model-row-card-llama3.2')
    expect(within(free).getByTestId('model-price')).toHaveTextContent(/^Free$/)
    expect(screen.queryByText(/\$0 in/)).not.toBeInTheDocument()
  })

  it('shows the model id under the name only when it differs from the name', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(OPENAI.id, 'deepseek-v4-flash:0731'),
      card(ANTHROPIC.id, 'claude-sonnet-5', { name: 'Claude Sonnet 5' }),
    ])
    at()
    const same = await screen.findByTestId('model-row-card-deepseek-v4-flash:0731')
    expect(within(same).getAllByText('deepseek-v4-flash:0731')).toHaveLength(1)
    expect(within(same).queryByTestId('model-id')).not.toBeInTheDocument()
    const differs = screen.getByTestId('model-row-card-claude-sonnet-5')
    expect(within(differs).getByTestId('model-id')).toHaveTextContent('claude-sonnet-5')
  })

  it('filters by provider', async () => {
    at()
    await screen.findByTestId('model-row-card-gpt-4o')
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by provider' }), { target: { value: ANTHROPIC.id } })
    expect(screen.getByTestId('model-group-prov-anthropic')).toBeInTheDocument()
    expect(screen.queryByTestId('model-group-prov-openai')).not.toBeInTheDocument()
  })

  it("opens a model on its provider's page", async () => {
    const { router } = at()
    fireEvent.click(within(await screen.findByTestId('model-row-card-o3')).getByRole('button'))
    expect(await screen.findByText('at /models/providers/prov-openai')).toBeInTheDocument()
    expect(router.state.location.hash).toBe('#model-card-o3')
  })

  it('with no provider connected, goes straight to connecting one', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([])
    at()
    const empty = await screen.findByTestId('models-empty')
    expect(within(empty).getByRole('heading', { name: 'Connect your first provider' })).toBeInTheDocument()
    expect(within(empty).getByRole('link', { name: 'Connect a provider' })).toHaveAttribute('href', '/models/connect')
    expect(within(empty).getByRole('link', { name: /OpenAI/ })).toHaveAttribute('href', '/models/connect?type=openai')
    expect(screen.queryByRole('heading', { name: 'All models' })).not.toBeInTheDocument()
  })

  it("lists a hosted model's provider row as the model, not as a connected provider", async () => {
    // The reconcile loop writes a provider row per hosted model; agents call
    // the model through it, but nobody connected it.
    const PLUMBING = { id: 'prov-qwen', name: 'Qwen on Modal', type: 'openai', status: 'active', lastSuccessAt: NOW, metadata: { managedBy: { kind: 'model_endpoint', id: 'd-1' } } }
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, PLUMBING] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([card(OPENAI.id, 'gpt-4o'), card(PLUMBING.id, 'qwen3-0.6b')])
    at()
    await screen.findByTestId('provider-card-prov-openai')
    expect(screen.queryByTestId('provider-card-prov-qwen')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Qwen on Modal' })).not.toBeInTheDocument()
    expect(within(await screen.findByTestId('model-group-__hosted__')).getByTestId('model-row-card-qwen3-0.6b')).toBeInTheDocument()
  })

  it('goes straight to connecting when the only provider rows belong to hosted models', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([{ id: 'prov-qwen', name: 'Qwen on Modal', type: 'openai', metadata: { managedBy: { kind: 'model_endpoint', id: 'd-1' } } }] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([])
    at()
    expect(await screen.findByTestId('models-empty')).toBeInTheDocument()
  })

  it('sends old ?tab=providers and ?new=1 links to connecting a provider', async () => {
    renderAtRoute(<ModelsPage />, { path: '/models', url: '/models?tab=providers', paths: ['/models/connect'] })
    expect(await screen.findByText('at /models/connect')).toBeInTheDocument()
  })
})
