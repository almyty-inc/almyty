/**
 * ModelPicker: one searchable list of every model, grouped by provider.
 *
 * The picker it replaced asked for a provider first and then a model from
 * that provider. These pin the single list: search, grouping, what a pick
 * emits, Automatic, the ways a saved or unlisted id stays visible, and the
 * way out when nothing is connected.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { ModelPicker, keyRejected, type ModelSelection } from '../model-picker'
import { llmProvidersApi } from '@/lib/api'
import { modelsApi } from '@/lib/models-api'
import { SEARCH_CASES, SEARCH_CATALOG, SEARCH_PROVIDER_ANTHROPIC, SEARCH_PROVIDER_OPENAI } from '@/lib/__tests__/model-search.cases'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn() },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn() } }))
vi.mock('@/components/models/routing-policy-editor', () => ({
  RoutingPolicyField: () => React.createElement('div', { 'data-testid': 'routing-policy-field' }),
}))
// The add-a-connection flow has its own tests; here it only has to open in
// place and hand back a connection.
vi.mock('@/components/llm-providers/provider-connection-create', () => ({
  ProviderConnectionCreate: (props: any) =>
    React.createElement(
      'div',
      { 'data-testid': 'connection-create' },
      React.createElement('button', { type: 'button', onClick: () => props.onDone({ id: 'prov-new', name: 'HF - Llama 70B only', type: 'huggingface' }) }, 'Finish adding'),
      React.createElement('button', { type: 'button', onClick: props.onCancel }, 'Stop adding'),
    ),
}))

const OPENAI = { id: 'prov-openai', name: 'OpenAI', type: 'openai', status: 'active' }
const ANTHROPIC = { id: 'prov-anthropic', name: 'Anthropic', type: 'anthropic', status: 'active' }
const LOCAL = { id: 'prov-local', name: 'Box under the desk', type: 'custom', status: 'active' }

function card(providerId: string, vendorModelId: string, over: Record<string, any> = {}) {
  return { id: `card-${vendorModelId}`, name: vendorModelId, vendorModelId, providerId, status: 'active', selectable: true, ...over } as any
}

const CARDS = [
  card(OPENAI.id, 'gpt-4o'),
  card(OPENAI.id, 'o3'),
  card(OPENAI.id, 'gpt-3.5-turbo', { selectable: false, status: 'inactive' }),
  card(ANTHROPIC.id, 'claude-sonnet-5', { name: 'Claude Sonnet 5' }),
]

function renderPicker(value: ModelSelection, props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onChange = vi.fn()
  const utils = renderWithProviders(<ModelPicker idPrefix="t" value={value} onChange={onChange} {...props} />)
  return { ...utils, onChange }
}

async function open() {
  const trigger = await screen.findByRole('combobox', { name: 'Model' })
  await vi.waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  return screen.getByRole('listbox')
}

/** What an option says about the model, without its price and status. */
const optionNames = (list: HTMLElement) => within(list).getAllByRole('option').map((o) => (o.querySelector('[data-testid=model-option-label]') ?? o).textContent)
const optionFor = (list: HTMLElement, model: string) => list.querySelector(`[role=option][data-model="${model}"]`) as HTMLElement

describe('ModelPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, ANTHROPIC, LOCAL] as any)
    vi.mocked(modelsApi.list).mockResolvedValue(CARDS)
  })

  it('is one searchable list of every model, grouped by provider, with no provider to pick first', async () => {
    renderPicker({})
    const list = await open()
    expect(within(list).getByRole('group', { name: 'OpenAI' })).toBeInTheDocument()
    expect(within(list).getByRole('group', { name: 'Anthropic' })).toBeInTheDocument()
    expect(within(within(list).getByRole('group', { name: 'Anthropic' })).getByRole('option', { name: /Claude Sonnet 5/ })).toBeInTheDocument()
    // One field: nothing asks for a provider on its own.
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument()
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    // All models in one request, not one per provider.
    expect(modelsApi.list).toHaveBeenCalledWith()
  })

  it('searches across models and providers', async () => {
    renderPicker({})
    const list = await open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'sonnet' } })
    expect(optionNames(list)).toEqual(['Claude Sonnet 5claude-sonnet-5'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'openai' } })
    expect(optionNames(list)).toEqual(['gpt-4o', 'o3'])
  })

  it('emits the provider and the model id together, and the provider as the second argument', async () => {
    const { onChange } = renderPicker({})
    const list = await open()
    fireEvent.click(within(list).getByRole('option', { name: /Claude Sonnet 5/ }))
    expect(onChange).toHaveBeenCalledWith({ providerId: ANTHROPIC.id, model: 'claude-sonnet-5' }, expect.objectContaining({ id: ANTHROPIC.id }))
    // The list closes on a pick.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('picks with the keyboard', async () => {
    const { onChange } = renderPicker({})
    await open()
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'o3' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ providerId: OPENAI.id, model: 'o3' }, expect.objectContaining({ id: OPENAI.id }))
  })

  it('shows the chosen model and its provider on the field', async () => {
    renderPicker({ providerId: ANTHROPIC.id, model: 'claude-sonnet-5' })
    const trigger = await screen.findByRole('combobox', { name: 'Model' })
    await vi.waitFor(() => expect(trigger).toHaveTextContent('Claude Sonnet 5'))
    expect(trigger).toHaveTextContent('Anthropic')
  })

  it('offers Automatic first when routing is allowed, and emits a routing policy', async () => {
    const { onChange, rerender } = renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' }, { allowRouting: true })
    const list = await open()
    const first = within(list).getAllByRole('option')[0]
    expect(first).toHaveTextContent('Automatic: the cheapest model that fits')
    fireEvent.click(first)
    expect(onChange).toHaveBeenCalledWith({ routing: { objective: 'cheapest' } })

    rerender(<ModelPicker idPrefix="t" allowRouting value={{ routing: { objective: 'cheapest' } }} onChange={onChange} />)
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Automatic: the cheapest model that fits')
    // The policy's knobs are there, folded away.
    expect(screen.queryByTestId('routing-policy-field')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Automatic settings' }))
    expect(screen.getByTestId('routing-policy-field')).toBeInTheDocument()
  })

  it('does not offer Automatic where routing is not allowed', async () => {
    renderPicker({})
    const list = await open()
    expect(within(list).queryByRole('option', { name: /Automatic/ })).not.toBeInTheDocument()
  })

  it('shows each model\'s price per million tokens in and out, and says so when nobody knows it', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([
      card(OPENAI.id, 'gpt-4o', { pricing: { inPerMTok: 2.5, outPerMTok: 10 } }),
      card(OPENAI.id, 'o3'),
      card(LOCAL.id, 'qwen3:8b', { pricing: { inPerMTok: 0, outPerMTok: 0 } }),
    ])
    renderPicker({})
    const list = await open()
    expect(within(optionFor(list, 'gpt-4o')).getByTestId('model-option-price')).toHaveTextContent('$2.50 / $10.00')
    expect(within(optionFor(list, 'o3')).getByTestId('model-option-price')).toHaveTextContent('Price unknown')
    expect(within(optionFor(list, 'qwen3:8b')).getByTestId('model-option-price')).toHaveTextContent('Free')
  })

  it('does not offer a model its connection turned off', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card(OPENAI.id, 'gpt-4o'), card(OPENAI.id, 'o3', { allowed: false, selectable: false })])
    renderPicker({})
    const list = await open()
    expect(optionNames(list)).toEqual(expect.not.arrayContaining(['o3']))
    expect(optionNames(list)).toContain('gpt-4o')
  })

  it('adds a connection right here, under the field, and lists its models when done', async () => {
    renderPicker({})
    await open()
    expect(screen.getByRole('link', { name: 'Manage connections' })).toHaveAttribute('href', '/models')
    fireEvent.click(screen.getByRole('button', { name: /Add a connection/ }))
    // No dialog and no new tab: the flow is part of the page.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const panel = screen.getByTestId('t-add-panel')
    expect(within(panel).getByTestId('connection-create')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    const calls = vi.mocked(modelsApi.list).mock.calls.length
    fireEvent.click(within(panel).getByRole('button', { name: 'Finish adding' }))
    expect(screen.queryByTestId('t-add-panel')).not.toBeInTheDocument()
    // Back in the list, which is fetched again for the new connection's models.
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    await vi.waitFor(() => expect(vi.mocked(modelsApi.list).mock.calls.length).toBeGreaterThan(calls))
  })

  it('locked to a provider, lists only its models and offers no new connection', async () => {
    const { onChange } = renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' }, { providerLocked: true })
    const list = await open()
    expect(within(list).queryByRole('group', { name: 'Anthropic' })).not.toBeInTheDocument()
    expect(optionNames(list)).toEqual(['gpt-4o', 'o3'])
    expect(screen.queryByRole('button', { name: /Add a connection/ })).not.toBeInTheDocument()
    fireEvent.click(optionFor(list, 'o3'))
    expect(onChange).toHaveBeenCalledWith({ providerId: OPENAI.id, model: 'o3' }, expect.objectContaining({ id: OPENAI.id }))
  })

  it('hides models that are not available, unless one is the saved choice', async () => {
    renderPicker({})
    const list = await open()
    expect(within(list).queryByRole('option', { name: /gpt-3.5-turbo/ })).not.toBeInTheDocument()
  })

  it('keeps a saved model that is no longer available, marked', async () => {
    renderPicker({ providerId: OPENAI.id, model: 'gpt-3.5-turbo' })
    expect(await screen.findByTestId('t-model-unavailable')).toHaveTextContent('not available')
    const list = await open()
    const saved = within(list).getByRole('option', { name: /gpt-3.5-turbo/ })
    expect(saved).toHaveAttribute('aria-selected', 'true')
    expect(within(saved).getByTestId('model-option-status')).toHaveTextContent('No longer offered')
  })

  it('keeps a saved id the provider does not list, instead of reading as unset', async () => {
    renderPicker({ providerId: OPENAI.id, model: 'ft:gpt-4o:acme' })
    const trigger = await screen.findByRole('combobox', { name: 'Model' })
    await vi.waitFor(() => expect(trigger).toHaveTextContent('ft:gpt-4o:acme'))
    const list = await open()
    expect(within(list).getByRole('option', { name: /ft:gpt-4o:acme.*Saved, not in the list/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('takes a model id that is not in the list when the search matches nothing', async () => {
    const { onChange } = renderPicker({ providerId: LOCAL.id })
    const list = await open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'qwen3:8b' } })
    const free = within(list).getByRole('option', { name: /Use model id "qwen3:8b"/ })
    expect(free).toHaveTextContent('with Box under the desk')
    fireEvent.click(free)
    expect(onChange).toHaveBeenCalledWith({ providerId: LOCAL.id, model: 'qwen3:8b' }, expect.objectContaining({ id: LOCAL.id }))
  })

  it('says what to do for your own server that lists nothing', async () => {
    renderPicker({})
    const list = await open()
    expect(within(within(list).getByRole('group', { name: 'Box under the desk' })).getByText('Type the model id your server runs.')).toBeInTheDocument()
  })

  it('says a provider has models listed but none usable, not that it has none', async () => {
    const MISTRAL = { id: 'prov-mistral', name: 'Mistral', type: 'mistral', status: 'active' }
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, MISTRAL] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([
      ...CARDS,
      card(MISTRAL.id, 'mistral-large', { selectable: false, validationStatus: 'never' }),
      card(MISTRAL.id, 'mistral-small', { selectable: false, validationStatus: 'never' }),
    ])
    renderPicker({})
    const list = await open()
    const group = within(list).getByRole('group', { name: 'Mistral' })
    expect(within(group).getByText('2 models listed, none usable yet. Check the provider again on its page.')).toBeInTheDocument()
    expect(within(group).queryByText(/No models yet/)).not.toBeInTheDocument()
  })

  it('offers exactly the models the Models page shows as available, from the same list', async () => {
    // Staging's shape once the provider checks are applied: every listed
    // model of a checked provider is usable, gpt-4o included.
    const GOOGLE = { id: 'prov-google', name: 'Google', type: 'google', status: 'active' }
    const cards = [
      card(OPENAI.id, 'gpt-4o'),
      card(OPENAI.id, 'gpt-4o-mini'),
      card(GOOGLE.id, 'gemini-2.5-flash'),
      card(OPENAI.id, 'gpt-3.5-turbo', { selectable: false, status: 'inactive' }),
    ]
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, GOOGLE] as any)
    vi.mocked(modelsApi.list).mockResolvedValue(cards)
    renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' })
    expect(screen.queryByTestId('t-model-unavailable')).not.toBeInTheDocument()
    const list = await open()
    const offered = optionNames(list).sort()
    expect(offered).toEqual(cards.filter((c) => c.selectable).map((c) => c.vendorModelId).sort())
    expect(optionFor(list, 'gpt-4o')).toHaveAttribute('aria-selected', 'true')
    expect(within(list).queryByTestId('model-option-status')).not.toBeInTheDocument()
  })

  it('offers "Provider default" per provider when the model is optional', async () => {
    const { onChange } = renderPicker({}, { modelOptional: true })
    const list = await open()
    fireEvent.click(within(within(list).getByRole('group', { name: 'OpenAI' })).getByRole('option', { name: 'Provider default' }))
    expect(onChange).toHaveBeenCalledWith({ providerId: OPENAI.id, model: '' }, expect.objectContaining({ id: OPENAI.id }))
  })

  it('offers the optional label as the first choice, which clears the value', async () => {
    const { onChange } = renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' }, { providerOptionalLabel: 'Organization default routing policy' })
    const list = await open()
    const first = within(list).getAllByRole('option')[0]
    expect(first).toHaveTextContent('Organization default routing policy')
    fireEvent.click(first)
    expect(onChange).toHaveBeenCalledWith({})
  })

  it('lists only active providers when asked to', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, { ...ANTHROPIC, status: 'inactive' }] as any)
    renderPicker({}, { activeOnly: true })
    const list = await open()
    expect(within(list).queryByRole('group', { name: 'Anthropic' })).not.toBeInTheDocument()
    expect(within(list).getByRole('group', { name: 'OpenAI' })).toBeInTheDocument()
  })

  it('with no connection yet, adds one right where the model is asked for', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([] as any)
    renderPicker({})
    const empty = await screen.findByTestId('no-providers')
    expect(empty).toHaveTextContent('No provider connections yet.')
    fireEvent.click(within(empty).getByRole('button', { name: /Add a connection/ }))
    expect(screen.getByTestId('t-add-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop adding' }))
    expect(screen.queryByTestId('t-add-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('no-providers')).toBeInTheDocument()
  })

  it('shows loading while the list is on its way', async () => {
    vi.mocked(modelsApi.list).mockReturnValue(new Promise(() => {}))
    renderPicker({})
    expect(await screen.findByTestId('t-model-loading')).toHaveTextContent('Loading models')
  })
})

describe('ModelPicker search relevance', () => {
  const PROVIDERS = [
    { id: 'prov-openai', ...SEARCH_PROVIDER_OPENAI, status: 'active' },
    { id: 'prov-anthropic', ...SEARCH_PROVIDER_ANTHROPIC, status: 'active' },
  ]
  const providerId = (name?: string | null) => PROVIDERS.find((p) => p.name === name)!.id
  const SEARCH_CARDS = SEARCH_CATALOG.map((m) => card(providerId(m.providerName), m.id, m.name ? { name: m.name } : {}))

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue(PROVIDERS as any)
    vi.mocked(modelsApi.list).mockResolvedValue(SEARCH_CARDS)
  })

  const listedIds = (list: HTMLElement) =>
    within(list)
      .queryAllByRole('option')
      .map((o) => o.getAttribute('data-model'))
      .filter((id): id is string => !!id)

  it.each(SEARCH_CASES)('"$query" lists $expected ($why)', async ({ query, expected }) => {
    renderPicker({})
    const list = await open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: query } })
    // The picker sorts each provider's models by label before ranking, so compare the set here.
    expect(listedIds(list).sort()).toEqual([...expected].sort())
  })

  it('lists only the gpt-4o models for "gpt-4o", exact id first, under a provider named after it', async () => {
    renderPicker({})
    const list = await open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'gpt-4o' } })
    expect(listedIds(list)).toEqual(['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'chatgpt-4o-latest'])
    expect(within(list).queryByRole('option', { name: /gpt-3\.5-turbo|dall-e-3/ })).not.toBeInTheDocument()
  })

  it('offers "Provider default" for a provider only when its name is what matched', async () => {
    renderPicker({}, { modelOptional: true })
    const list = await open()
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'gpt-4o' } })
    expect(within(list).queryByRole('option', { name: /Provider default/ })).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'openai' } })
    expect(within(list).getAllByRole('option', { name: /Provider default/ })).toHaveLength(1)
  })
})

describe('keyRejected', () => {
  it.each([
    'Request failed with status code 401',
    'Request failed with status code 403',
    '401 Incorrect API key provided: sk-...',
    '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  ])('treats %s from the vendor as a rejected key', (message) => {
    expect(keyRejected({ response: { status: 502, data: { message } } })).toBe(true)
  })

  it('does not blame the key for almyty refusing the request itself', () => {
    expect(keyRejected({ response: { status: 403, data: { message: 'Forbidden resource' } } })).toBe(false)
  })
})
