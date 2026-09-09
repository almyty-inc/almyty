import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import type { Node } from '@xyflow/react'

import { render } from '../../../test/setup'
import { RoutingPolicyEditor } from '../routing-policy-editor'
import { NodeConfigPanel } from '../../agents/node-config-panel'
import { modelsApi } from '../../../lib/models-api'

vi.mock('../../../lib/api', () => ({
  llmProvidersApi: {
    getAll: vi.fn().mockResolvedValue([{ id: 'p1', name: 'OpenAI', type: 'openai' }]),
    getModels: vi.fn().mockResolvedValue([]),
  },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../../lib/models-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/models-api')>('../../../lib/models-api')
  return { ...actual, modelsApi: { list: vi.fn().mockResolvedValue([]) } }
})

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))

const cards = [
  { id: 'c1', name: 'Sonnet', vendorModelId: 'claude-sonnet-5', privacyTier: 'public' as const, region: null },
  { id: 'c2', name: 'qwen3-14b', vendorModelId: 'qwen3-14b', privacyTier: 'local' as const, region: 'eu-central' },
]

describe('RoutingPolicyEditor', () => {
  it('adds regions as chips and keeps the rest of the policy', async () => {
    const onChange = vi.fn()
    render(<RoutingPolicyEditor value={{ objective: 'cheapest', privacyTier: 'private_cloud' }} onChange={onChange} cards={cards} />)

    await userEvent.type(screen.getByLabelText('Regions'), 'eu-central{enter}')
    expect(onChange).toHaveBeenLastCalledWith({ objective: 'cheapest', privacyTier: 'private_cloud', regions: ['eu-central'] })
  })

  it('toggles required capabilities and drops the key when unchecked', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<RoutingPolicyEditor value={{ objective: 'fastest' }} onChange={onChange} cards={cards} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Tools' }))
    expect(onChange).toHaveBeenLastCalledWith({ objective: 'fastest', capabilities: { tools: true } })

    rerender(<RoutingPolicyEditor value={{ objective: 'fastest', capabilities: { tools: true } }} onChange={onChange} cards={cards} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tools' }))
    expect(onChange).toHaveBeenLastCalledWith({ objective: 'fastest' })
  })

  it('reorders and removes cards in the fallback chain', async () => {
    const onChange = vi.fn()
    render(<RoutingPolicyEditor value={{ fallbackChain: ['c1', 'c2'] }} onChange={onChange} cards={cards} />)

    expect(screen.getByText('Sonnet (claude-sonnet-5)')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move qwen3-14b up' }))
    expect(onChange).toHaveBeenLastCalledWith({ fallbackChain: ['c2', 'c1'] })

    await userEvent.click(screen.getByRole('button', { name: 'Remove Sonnet (claude-sonnet-5) from chain' }))
    expect(onChange).toHaveBeenLastCalledWith({ fallbackChain: ['c2'] })
  })

  it('stores budget headroom as a number and clears it when emptied', async () => {
    const onChange = vi.fn()
    render(<RoutingPolicyEditor value={{ objective: 'cheapest' }} onChange={onChange} cards={cards} />)
    await userEvent.type(screen.getByLabelText('Budget headroom, cents'), '5')
    expect(onChange).toHaveBeenLastCalledWith({ objective: 'cheapest', budgetHeadroomCents: 5 })
  })

  it('shows the pinned card picker only for the pinned objective', () => {
    const { rerender } = render(<RoutingPolicyEditor value={{ objective: 'cheapest' }} onChange={() => {}} cards={cards} />)
    expect(screen.queryByLabelText('Pinned card')).not.toBeInTheDocument()
    rerender(<RoutingPolicyEditor value={{ objective: 'pinned', pinnedModel: 'c1' }} onChange={() => {}} cards={cards} />)
    expect(screen.getByLabelText('Pinned card')).toBeInTheDocument()
  })
})

describe('LLM call node: model selection', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(modelsApi.list).mockResolvedValue([])
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  const llmNode = (data: Record<string, unknown>): Node => ({ id: 'llm_1', type: 'llm_call', position: { x: 0, y: 0 }, data })

  it('switching to routed clears the pinned provider and writes config.routing', async () => {
    const onUpdateNode = vi.fn()
    render(
      <NodeConfigPanel
        node={llmNode({ providerId: 'p1', providerName: 'OpenAI', providerType: 'openai', model: 'gpt-5', systemPrompt: 'hi', temperature: 0.2 })}
        nodes={[]}
        onUpdateNode={onUpdateNode}
        onDeleteNode={() => {}}
        onClose={() => {}}
      />,
      { queryClient },
    )

    expect(screen.getByRole('radio', { name: 'Pinned provider' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('radio', { name: 'Routed by policy' }))

    expect(onUpdateNode).toHaveBeenCalledWith('llm_1', { systemPrompt: 'hi', temperature: 0.2, routing: { objective: 'cheapest' } })
    const written = onUpdateNode.mock.calls[0][1]
    expect(written).not.toHaveProperty('providerId')
    expect(written).not.toHaveProperty('model')
  })

  it('renders the policy editor for a routed node and persists edits under routing', async () => {
    const onUpdateNode = vi.fn()
    render(
      <NodeConfigPanel
        node={llmNode({ routing: { objective: 'cheapest' }, systemPrompt: 'hi' })}
        nodes={[]}
        onUpdateNode={onUpdateNode}
        onDeleteNode={() => {}}
        onClose={() => {}}
      />,
      { queryClient },
    )

    expect(screen.getByRole('radio', { name: 'Routed by policy' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('routing-policy-editor')).toBeInTheDocument()
    expect(screen.queryByText('LLM Provider')).not.toBeInTheDocument()
    await waitFor(() => expect(modelsApi.list).toHaveBeenCalledWith({ selectable: true }))

    await userEvent.click(screen.getByRole('checkbox', { name: 'Vision' }))
    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_1', {
      routing: { objective: 'cheapest', capabilities: { vision: true } },
      systemPrompt: 'hi',
    })
  })

  it('switching back to pinned removes routing', async () => {
    const onUpdateNode = vi.fn()
    render(
      <NodeConfigPanel
        node={llmNode({ routing: { objective: 'fastest', regions: ['eu-central'] }, systemPrompt: 'hi' })}
        nodes={[]}
        onUpdateNode={onUpdateNode}
        onDeleteNode={() => {}}
        onClose={() => {}}
      />,
      { queryClient },
    )
    await userEvent.click(screen.getByRole('radio', { name: 'Pinned provider' }))
    expect(onUpdateNode).toHaveBeenCalledWith('llm_1', { systemPrompt: 'hi' })
  })
})
