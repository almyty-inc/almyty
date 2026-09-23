/**
 * The LLM node's Model field, now the shared ModelPicker.
 *
 * Radix renders a Select's placeholder whenever `value` matches no SelectItem,
 * and it does so silently. A saved model the provider's list does not return
 * -- a dated snapshot id, a fine-tune, a retired model -- used to read as
 * "Select model" while the node still held and executed the saved value.
 * The picker keeps such a value as its own option, so it stays on screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import type { Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { NodeConfigPanel } from '../node-config-panel'
import { llmProvidersApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: {
    getAll: vi.fn().mockResolvedValue([{ id: 'prov-1', name: 'OpenAI', type: 'openai' }]),
    getModels: vi.fn(),
  },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
}))
// No catalog cards, so the picker lists what the provider returns.
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]) } }))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))

// Not under test and each pulls in a heavy editor.
vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))
vi.mock('@/components/JsonSchemaBuilder', () => ({ JsonSchemaBuilder: () => null }))
vi.mock('@/components/ui/code-editor', () => ({ CodeEditor: () => null }))

const LISTED = 'gpt-4o'
// A dated snapshot: real, callable, and absent from the provider's list.
const SAVED_BUT_UNLISTED = 'gpt-4o-2024-05-13'

function llmNode(model: string): Node {
  return {
    id: 'llm_1',
    type: 'llm_call',
    position: { x: 0, y: 0 },
    data: { providerId: 'prov-1', providerName: 'OpenAI', providerType: 'openai', model },
  }
}

function renderPanel(model: string, onUpdateNode = vi.fn()) {
  const node = llmNode(model)
  renderWithProviders(
    <NodeConfigPanel
      node={node}
      nodes={[node]}
      onUpdateNode={onUpdateNode}
      onDeleteNode={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return onUpdateNode
}

describe('LLM node model field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getModels).mockResolvedValue([{ id: LISTED }] as any)
  })

  it('shows a saved model the provider does not list instead of a blank placeholder', async () => {
    renderPanel(SAVED_BUT_UNLISTED)

    // The select only exists once the list has landed, so waiting for it is
    // the signal that the loading state is over.
    await screen.findByTestId('node-model-select')
    await waitFor(() => expect(screen.getAllByText(SAVED_BUT_UNLISTED).length).toBeGreaterThan(0))
    expect(screen.queryByText('Select model')).not.toBeInTheDocument()
  })

  it('selects from the provider list rather than asking for typed text', async () => {
    renderPanel(LISTED)

    await screen.findByTestId('node-model-select')
    expect(screen.queryByTestId('node-model-input')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use a model id not in the list' })).toBeInTheDocument()
  })

  it('writes a typed model id through the escape hatch, keeping the provider', async () => {
    const onUpdateNode = renderPanel(LISTED)
    await screen.findByTestId('node-model-select')

    fireEvent.click(screen.getByRole('button', { name: 'Use a model id not in the list' }))
    fireEvent.change(screen.getByTestId('node-model-input'), { target: { value: 'ft:gpt-4o:acme' } })

    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_1', expect.objectContaining({
      providerId: 'prov-1',
      providerName: 'OpenAI',
      providerType: 'openai',
      model: 'ft:gpt-4o:acme',
    }))
  })
})