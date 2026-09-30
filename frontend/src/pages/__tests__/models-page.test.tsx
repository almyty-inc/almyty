/**
 * /models: the catalog. Every model every provider connection reaches,
 * with price and status, in one table, filterable by connection and status.
 * Connections are managed on their own pages; each row links to its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { ModelsPage } from '../models'
import { llmProvidersApi } from '@/lib/api'
import { modelsApi } from '@/lib/models-api'
import { SEARCH_CASES, SEARCH_CATALOG, SEARCH_PROVIDER_ANTHROPIC, SEARCH_PROVIDER_OPENAI } from '@/lib/__tests__/model-search.cases'

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
const HF_PINNED = { id: 'prov-hf-1', name: 'HF - Llama 70B only', type: 'huggingface', status: 'active', keyChecked: true, allowNewModels: false, allowedModels: ['meta-llama/Llama-3.3-70B-Instruct'] }
const HF_ALL = { id: 'prov-hf-2', name: 'HF - everything', type: 'huggingface', status: 'active', keyChecked: true }
const GROQ = { id: 'prov-groq', name: 'Groq', type: 'groq', status: 'error', lastError: 'Request failed with status code 401', lastErrorAt: NOW }

function card(providerId: string, vendorModelId: string, over: Record<string, any> = {}) {
  return {
    id: `card-${providerId}-${vendorModelId}`,
    name: vendorModelId,
    vendorModelId,
    providerId,
    status: 'active',
    selectable: true,
    allowed: true,
    validationStatus: 'passed',
    lastValidationError: null,
    pricing: null,
    pricingOverride: null,
    contextLength: null,
    metadata: null,
    ...over,
  } as any
}

const LLAMA = 'meta-llama/Llama-3.3-70B-Instruct'
const QWEN = 'Qwen/Qwen3-32B'
const CARDS = [
  card(OPENAI.id, 'gpt-4o', { pricing: { inPerMTok: 2.5, outPerMTok: 10 }, contextLength: 128000 }),
  // Your own price wins over the provider's.
  card(OPENAI.id, 'o3', { pricing: { inPerMTok: 10, outPerMTok: 40 }, pricingOverride: { inPerMTok: 1, outPerMTok: 4 }, contextLength: 1_000_000, isNew: true }),
  card(OPENAI.id, 'gpt-3.5-turbo', { selectable: false, status: 'inactive', metadata: { retiredReason: 'No longer listed by OpenAI' } }),
  card(HF_PINNED.id, LLAMA),
  card(HF_PINNED.id, QWEN, { allowed: false, selectable: false }),
  card(HF_ALL.id, LLAMA),
  card(HF_ALL.id, QWEN),
  card(GROQ.id, 'llama-4', { selectable: false }),
]

const at = (url = '/models') => renderAtRoute(<ModelsPage />, { path: '/models', url, paths: ['/credentials/providers/new', '/credentials/providers/:id'] })
const rowOf = async (id: string) => (await screen.findByTestId(`catalog-row-${id}`)).closest('tr') as HTMLElement
const listedIds = () => screen.queryAllByTestId(/^catalog-row-/).map((el) => el.getAttribute('data-testid')!.replace('catalog-row-', ''))

describe('ModelsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, HF_PINNED, HF_ALL, GROQ] as any)
    vi.mocked(modelsApi.list).mockResolvedValue(CARDS)
  })

  it('is one table of every model, with its connection, price per 1M, context and status', async () => {
    at()
    const gpt4o = await rowOf('card-prov-openai-gpt-4o')
    expect(within(gpt4o).getByTestId('catalog-connection')).toHaveTextContent('OpenAI')
    expect(within(gpt4o).getByTestId('catalog-connection')).toHaveAttribute('href', '/credentials/providers/prov-openai')
    expect(within(gpt4o).getByTestId('model-price')).toHaveTextContent('$2.50 in / $10.00 out')
    expect(within(gpt4o).getByTestId('model-context')).toHaveTextContent('128k')
    expect(within(gpt4o).getByTestId('model-availability')).toHaveTextContent('Available')
    const o3 = await rowOf('card-prov-openai-o3')
    expect(within(o3).getByTestId('model-price')).toHaveTextContent('$1.00 in / $4.00 out')
    expect(within(o3).getByTestId('model-context')).toHaveTextContent('1M')
    expect(screen.getByRole('columnheader', { name: 'Price per 1M tokens' })).toBeInTheDocument()
  })

  it('lists the same model once per connection that reaches it', async () => {
    at()
    expect((await rowOf(`card-prov-hf-1-${LLAMA}`)).textContent).toContain('HF - Llama 70B only')
    expect((await rowOf(`card-prov-hf-2-${LLAMA}`)).textContent).toContain('HF - everything')
  })

  it('manages no connections itself: the one action is connecting a provider', async () => {
    at()
    await rowOf('card-prov-openai-gpt-4o')
    expect(screen.getByRole('link', { name: /Connect a provider/ })).toHaveAttribute('href', '/credentials/providers/new')
    expect(screen.queryByTestId(/^provider-card-/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove|Rename|Replace key/ })).not.toBeInTheDocument()
  })

  it('marks new models and says why a model cannot be used, a turned-off one included', async () => {
    at()
    expect(within(await rowOf('card-prov-openai-o3')).getByTestId('model-new')).toHaveTextContent('New')
    expect(within(await rowOf('card-prov-openai-gpt-4o')).queryByTestId('model-new')).not.toBeInTheDocument()
    expect(within(await rowOf('card-prov-openai-gpt-3.5-turbo')).getByTestId('model-availability')).toHaveTextContent('No longer offered')
    expect(within(await rowOf(`card-prov-hf-1-${QWEN}`)).getByTestId('model-availability')).toHaveTextContent(/^Not allowed on /)
    expect(within(await rowOf('card-prov-groq-llama-4')).getByTestId('model-availability')).toHaveTextContent('Provider check failed')
  })

  it('filters by connection and by status', async () => {
    at()
    await rowOf('card-prov-openai-gpt-4o')
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by connection' }), { target: { value: HF_PINNED.id } })
    expect(listedIds().sort()).toEqual([`card-prov-hf-1-${LLAMA}`, `card-prov-hf-1-${QWEN}`].sort())
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'off' } })
    expect(listedIds()).toEqual([`card-prov-hf-1-${QWEN}`])
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by connection' }), { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'unavailable' } })
    expect(listedIds().sort()).toEqual(['card-prov-groq-llama-4', 'card-prov-openai-gpt-3.5-turbo'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'new' } })
    expect(listedIds()).toEqual(['card-prov-openai-o3'])
  })

  it('opens filtered from a notice link', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([...CARDS, card(HF_PINNED.id, 'google/gemma-4', { isNew: true })])
    at(`/models?connection=${HF_PINNED.id}&show=new`)
    await rowOf(`card-prov-hf-1-google/gemma-4`)
    expect(listedIds()).toEqual(['card-prov-hf-1-google/gemma-4'])
    expect(screen.getByRole('combobox', { name: 'Filter by connection' })).toHaveValue(HF_PINNED.id)
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toHaveValue('new')
  })

  it('opens a model on its connection\'s page', async () => {
    const { router } = at()
    fireEvent.click(within(await rowOf('card-prov-openai-o3')).getByText('o3'))
    expect(await screen.findByText('at /credentials/providers/prov-openai')).toBeInTheDocument()
    expect(router.state.location.hash).toBe('#model-card-prov-openai-o3')
  })

  it('shows an unknown price as unknown and a free model as free', async () => {
    const OLLAMA = { id: 'prov-ollama', name: 'Ollama box', type: 'ollama', status: 'active', keyChecked: true }
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, OLLAMA] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([card(OPENAI.id, 'gpt-image-2'), card(OLLAMA.id, 'llama3.2', { pricing: { inPerMTok: 0, outPerMTok: 0, currency: 'USD' } })])
    at()
    expect(within(await rowOf('card-prov-openai-gpt-image-2')).getByTestId('model-price')).toHaveTextContent(/^Price unknown$/)
    expect(within(await rowOf('card-prov-ollama-llama3.2')).getByTestId('model-price')).toHaveTextContent(/^Free$/)
  })

  it('with no connection, says so and offers to connect a provider', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([])
    at()
    expect(await screen.findByText('No models yet')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Connect a provider/ }).every((l) => l.getAttribute('href') === '/credentials/providers/new')).toBe(true)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it("lists a hosted model under your cloud, not its provider row as a connection", async () => {
    const PLUMBING = { id: 'prov-qwen', name: 'Qwen on Modal', type: 'openai', status: 'active', metadata: { managedBy: { kind: 'model_endpoint', id: 'd-1' } } }
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, PLUMBING] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([card(OPENAI.id, 'gpt-4o'), card(PLUMBING.id, 'qwen3-0.6b')])
    at()
    expect((await rowOf('card-prov-qwen-qwen3-0.6b')).textContent).toContain('Your cloud')
    expect(screen.queryByRole('option', { name: 'Qwen on Modal' })).not.toBeInTheDocument()
  })

  describe('search relevance (the shared model search cases)', () => {
    const PROVIDERS = [
      { ...OPENAI, ...SEARCH_PROVIDER_OPENAI },
      { id: 'prov-anthropic', name: 'Anthropic', type: 'anthropic', status: 'active', keyChecked: true, ...SEARCH_PROVIDER_ANTHROPIC },
    ]
    const providerId = (name?: string | null) => PROVIDERS.find((p) => p.name === name)!.id
    const ids = () => listedIds().map((id) => id.replace(/^card-prov-(openai|anthropic)-/, ''))

    beforeEach(() => {
      vi.mocked(llmProvidersApi.getAll).mockResolvedValue(PROVIDERS as any)
      vi.mocked(modelsApi.list).mockResolvedValue(SEARCH_CATALOG.map((m) => card(providerId(m.providerName), m.id, m.name ? { name: m.name } : {})))
    })

    it.each(SEARCH_CASES)('"$query" lists $expected ($why)', async ({ query, expected }) => {
      at()
      await screen.findByTestId(/^catalog-row-card-prov-openai-gpt-4o$/)
      fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: query } })
      expect(ids().sort()).toEqual([...expected].sort())
    })

    it('lists only the gpt-4o models for "gpt-4o", exact id first', async () => {
      at()
      await screen.findByTestId(/^catalog-row-card-prov-openai-gpt-4o$/)
      fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'gpt-4o' } })
      expect(ids()).toEqual(['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'chatgpt-4o-latest'])
    })
  })
})
