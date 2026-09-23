/**
 * ModelPicker: the model depends on the provider.
 *
 * The screens it replaced put a free-text model box next to a provider
 * select. These pin the behaviour that replaced it: disabled until a
 * provider is chosen, a select of the catalog's cards (validated or not)
 * or else the provider's live list, free text only for a self-hosted
 * provider, an unreadable or empty list, or the explicit escape hatch.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { ModelPicker, type ModelSelection } from '../model-picker'
import { llmProvidersApi } from '@/lib/api'
import { modelsApi } from '@/lib/models-api'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn(), getModels: vi.fn() },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn() } }))
vi.mock('@/components/models/routing-policy-editor', () => ({
  RoutingPolicyField: () => React.createElement('div', { 'data-testid': 'routing-policy-field' }),
}))

// Radix Select does not open in jsdom. A native <select> keeps what is under
// test -- which options exist, which is chosen, what a choice emits -- and
// takes its label and test id from the trigger, as the real one does.
vi.mock('@/components/ui/select', async () => {
  const R = await import('react')
  const textOf = (node: any): string =>
    node == null || typeof node === 'boolean'
      ? ''
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : Array.isArray(node)
          ? node.map(textOf).join('')
          : textOf(node.props?.children)
  const SelectTrigger = () => null
  return {
    Select: ({ value, onValueChange, disabled, children }: any) => {
      const trigger = R.Children.toArray(children).find((c: any) => c?.type === SelectTrigger) as any
      return R.createElement(
        'select',
        {
          value: value ?? '',
          disabled,
          'aria-label': trigger?.props['aria-label'],
          'data-testid': trigger?.props['data-testid'],
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        R.createElement('option', { value: '' }, '--'),
        children,
      )
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => R.createElement(R.Fragment, null, children),
    SelectItem: ({ value, disabled, children }: any) => R.createElement('option', { value, disabled }, textOf(children)),
  }
})

const OPENAI = { id: 'prov-openai', name: 'OpenAI', type: 'openai', status: 'active' }
const LOCAL = { id: 'prov-local', name: 'Box under the desk', type: 'custom', status: 'active' }

function card(vendorModelId: string, selectable: boolean) {
  return { id: `card-${vendorModelId}`, name: vendorModelId, vendorModelId, providerId: OPENAI.id, status: 'active', selectable } as any
}

function renderPicker(value: ModelSelection, props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onChange = vi.fn()
  const utils = renderWithProviders(<ModelPicker idPrefix="t" value={value} onChange={onChange} {...props} />)
  return { ...utils, onChange }
}

const modelSelect = () => screen.getByLabelText('Model', { selector: 'select' })

describe('ModelPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, LOCAL] as any)
    vi.mocked(modelsApi.list).mockResolvedValue([])
    vi.mocked(llmProvidersApi.getModels).mockResolvedValue([])
  })

  it('keeps the model disabled until a provider is chosen, and says so', async () => {
    renderPicker({})
    await screen.findByLabelText('Provider', { selector: 'select' })
    const model = screen.getByTestId('t-model-disabled')
    expect(model).toBeDisabled()
    expect(screen.getByText('The models on offer depend on the provider.')).toBeInTheDocument()
    expect(screen.queryByTestId('t-model-input')).not.toBeInTheDocument()
    expect(modelsApi.list).not.toHaveBeenCalled()
    expect(llmProvidersApi.getModels).not.toHaveBeenCalled()
  })

  it('offers the catalog cards for the provider, marked validated or not, without asking the vendor', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card('gpt-4o', true), card('gpt-4.1-mini', false)])
    renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' })

    const select = await screen.findByTestId('t-model-select')
    const options = within(select).getAllByRole('option').map((o) => o.textContent)
    expect(options).toContain('gpt-4oValidated')
    expect(options).toContain('gpt-4.1-miniNot validated')
    expect(select).toHaveValue('gpt-4o')
    expect(modelsApi.list).toHaveBeenCalledWith({ providerId: OPENAI.id })
    expect(llmProvidersApi.getModels).not.toHaveBeenCalled()
    // Never a bare text field while a list exists.
    expect(screen.queryByTestId('t-model-input')).not.toBeInTheDocument()
  })

  it('falls back to the provider live list when the catalog has no cards for it', async () => {
    vi.mocked(llmProvidersApi.getModels).mockResolvedValue([{ id: 'gpt-4o', name: 'gpt-4o' }, { id: 'o3', name: 'o3' }] as any)
    renderPicker({ providerId: OPENAI.id })

    const select = await screen.findByTestId('t-model-select')
    expect(within(select).getByRole('option', { name: 'o3' })).toBeInTheDocument()
    expect(llmProvidersApi.getModels).toHaveBeenCalledWith(OPENAI.id)
  })

  it('shows a loading state while the list is on its way', async () => {
    vi.mocked(modelsApi.list).mockReturnValue(new Promise(() => {}))
    renderPicker({ providerId: OPENAI.id })
    expect(await screen.findByTestId('t-model-loading')).toHaveTextContent('Loading models')
  })

  it('emits the chosen model with the provider', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card('gpt-4o', true), card('o3', true)])
    const { onChange } = renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' })
    fireEvent.change(await screen.findByTestId('t-model-select'), { target: { value: 'o3' } })
    expect(onChange).toHaveBeenCalledWith({ providerId: OPENAI.id, model: 'o3' }, expect.objectContaining({ id: OPENAI.id }))
  })

  it('clears the model when the provider changes', async () => {
    const { onChange } = renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' })
    fireEvent.change(await screen.findByLabelText('Provider', { selector: 'select' }), { target: { value: LOCAL.id } })
    expect(onChange).toHaveBeenCalledWith({ providerId: LOCAL.id, model: '' }, expect.objectContaining({ id: LOCAL.id }))
  })

  it('keeps a saved model the list does not return, instead of reading as unset', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card('gpt-4o', true)])
    renderPicker({ providerId: OPENAI.id, model: 'gpt-4o-2024-05-13' })
    const select = await screen.findByTestId('t-model-select')
    expect(select).toHaveValue('gpt-4o-2024-05-13')
    expect(within(select).getByRole('option', { name: /gpt-4o-2024-05-13.*not in the list/ })).toBeInTheDocument()
  })

  it('offers free text only through the explicit escape hatch when a list exists', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card('gpt-4o', true)])
    const { onChange } = renderPicker({ providerId: OPENAI.id, model: '' })
    await screen.findByTestId('t-model-select')

    fireEvent.click(screen.getByRole('button', { name: 'Use a model id not in the list' }))
    const input = screen.getByTestId('t-model-input')
    fireEvent.change(input, { target: { value: 'ft:gpt-4o:acme' } })
    expect(onChange).toHaveBeenLastCalledWith({ providerId: OPENAI.id, model: 'ft:gpt-4o:acme' }, expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Choose from the list' }))
    expect(screen.getByTestId('t-model-select')).toBeInTheDocument()
  })

  it('goes straight to free text for a self-hosted provider, without listing', async () => {
    renderPicker({ providerId: LOCAL.id })
    expect(await screen.findByTestId('t-model-input')).toBeInTheDocument()
    expect(screen.getByText('This provider is self-hosted, so type the model id it serves.')).toBeInTheDocument()
    expect(modelsApi.list).not.toHaveBeenCalled()
    expect(llmProvidersApi.getModels).not.toHaveBeenCalled()
  })

  it('says why and falls back to free text when the list cannot be read', async () => {
    vi.mocked(llmProvidersApi.getModels).mockRejectedValue(new Error('upstream 503'))
    renderPicker({ providerId: OPENAI.id })
    expect(await screen.findByTestId('t-model-error')).toHaveTextContent('upstream 503')
    expect(screen.getByTestId('t-model-input')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/ }))
    await waitFor(() => expect(llmProvidersApi.getModels).toHaveBeenCalledTimes(2))
  })

  it('says so when the provider lists nothing', async () => {
    renderPicker({ providerId: OPENAI.id })
    expect(await screen.findByTestId('t-model-empty')).toHaveTextContent('This provider lists no models.')
    expect(screen.getByTestId('t-model-input')).toBeInTheDocument()
  })

  it('offers "Provider default" when the model is optional', async () => {
    vi.mocked(modelsApi.list).mockResolvedValue([card('gpt-4o', true)])
    const { onChange } = renderPicker({ providerId: OPENAI.id, model: '' }, { modelOptional: true })
    const select = await screen.findByTestId('t-model-select')
    expect(within(select).getByRole('option', { name: 'Provider default' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: '__provider_default__' } })
    expect(onChange).toHaveBeenCalledWith({ providerId: OPENAI.id, model: '' }, expect.anything())
  })

  it('keeps a working shortcut to connect a provider when there are none', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([] as any)
    renderPicker({})
    const empty = await screen.findByTestId('no-providers')
    const link = within(empty).getByRole('link', { name: /Connect one/ })
    expect(link).toHaveAttribute('href', '/llm-providers/new')
    // A new tab, so whatever was being built here is not thrown away.
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('lists only active providers when asked to', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI, { ...LOCAL, status: 'inactive' }] as any)
    renderPicker({}, { activeOnly: true })
    const select = await screen.findByLabelText('Provider', { selector: 'select' })
    expect(within(select).queryByRole('option', { name: /Box under the desk/ })).not.toBeInTheDocument()
    expect(within(select).getByRole('option', { name: /OpenAI/ })).toBeInTheDocument()
  })

  it('lets the provider be left to the organization default when optional', async () => {
    const { onChange } = renderPicker({ providerId: OPENAI.id }, { providerOptionalLabel: 'Organization default routing policy' })
    const select = await screen.findByLabelText('Provider', { selector: 'select' })
    fireEvent.change(select, { target: { value: '__no_provider__' } })
    expect(onChange).toHaveBeenCalledWith({})
  })

  it('switches between a pinned model and a routing policy', async () => {
    const { onChange, rerender } = renderPicker({ providerId: OPENAI.id, model: 'gpt-4o' }, { allowRouting: true })
    fireEvent.click(await screen.findByRole('radio', { name: 'Routed by policy' }))
    expect(onChange).toHaveBeenCalledWith({ routing: { objective: 'cheapest' } })

    rerender(<ModelPicker idPrefix="t" allowRouting value={{ routing: { objective: 'cheapest' } }} onChange={onChange} />)
    expect(screen.getByTestId('routing-policy-field')).toBeInTheDocument()
    expect(screen.queryByLabelText('Provider', { selector: 'select' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Pinned provider' }))
    expect(onChange).toHaveBeenLastCalledWith({})
  })
})
