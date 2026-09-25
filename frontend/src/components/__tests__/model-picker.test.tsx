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

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn() },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn() } }))
vi.mock('@/components/models/routing-policy-editor', () => ({
  RoutingPolicyField: () => React.createElement('div', { 'data-testid': 'routing-policy-field' }),
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

const optionNames = (list: HTMLElement) => within(list).getAllByRole('option').map((o) => o.textContent)

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

  it('links to connecting a provider in a new tab', async () => {
    renderPicker({})
    await open()
    const link = screen.getByRole('link', { name: /Connect a provider/ })
    expect(link).toHaveAttribute('href', '/models/connect')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('locked to a provider, lists only its models', async () => {
    const { onChange } = renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' }, { providerLocked: true })
    const list = await open()
    expect(within(list).queryByRole('group', { name: 'Anthropic' })).not.toBeInTheDocument()
    expect(optionNames(list)).toEqual(['gpt-4o', 'o3'])
    fireEvent.click(within(list).getByRole('option', { name: 'o3' }))
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
    expect(saved).toHaveTextContent('Not available')
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
    const offered = within(list).getAllByRole('option').map((o) => o.textContent).sort()
    expect(offered).toEqual(cards.filter((c) => c.selectable).map((c) => c.vendorModelId).sort())
    expect(within(list).getByRole('option', { name: 'gpt-4o' })).toHaveAttribute('aria-selected', 'true')
    expect(within(list).queryByText('Not available')).not.toBeInTheDocument()
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

  it('keeps a working shortcut to connect a provider when there are none', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([] as any)
    renderPicker({})
    const empty = await screen.findByTestId('no-providers')
    const link = within(empty).getByRole('link', { name: /Connect a provider/ })
    expect(link).toHaveAttribute('href', '/models/connect')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('shows loading while the list is on its way', async () => {
    vi.mocked(modelsApi.list).mockReturnValue(new Promise(() => {}))
    renderPicker({})
    expect(await screen.findByTestId('t-model-loading')).toHaveTextContent('Loading models')
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
