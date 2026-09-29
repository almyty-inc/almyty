/**
 * The LLM node's Model field, now the shared ModelPicker.
 *
 * A saved model the provider's list does not return -- a dated snapshot id,
 * a fine-tune, a retired model -- once read as "Select model" while the
 * node still held and executed the saved value. The picker keeps such a
 * value on the field and in the list, so it stays on screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import type { Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { NodeConfigPanel } from '../node-config-panel'
import { modelsApi } from '@/lib/models-api'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: {
    getAll: vi.fn().mockResolvedValue([{ id: 'prov-1', name: 'OpenAI', type: 'openai' }]),
  },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn() } }))

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

async function openPicker() {
  const trigger = await screen.findByTestId('node-model-trigger')
  await waitFor(() => expect(trigger).not.toBeDisabled())
  fireEvent.click(trigger)
  return screen.getByRole('listbox')
}

describe('LLM node model field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(modelsApi.list).mockResolvedValue([
      { id: 'c1', name: LISTED, vendorModelId: LISTED, providerId: 'prov-1', status: 'active', selectable: true },
    ] as any)
  })

  it('shows a saved model the provider does not list instead of a blank placeholder', async () => {
    renderPanel(SAVED_BUT_UNLISTED)
    await waitFor(() => expect(screen.getByTestId('node-model-value')).toHaveTextContent(SAVED_BUT_UNLISTED))
    expect(screen.queryByText('Select model')).not.toBeInTheDocument()
  })

  it('selects from the list rather than asking for typed text', async () => {
    const onUpdateNode = renderPanel(SAVED_BUT_UNLISTED)
    const list = await openPicker()
    expect(screen.queryByTestId('node-model-input')).not.toBeInTheDocument()
    fireEvent.click(within(list).getByRole('option', { name: LISTED }))
    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_1', expect.objectContaining({ providerId: 'prov-1', model: LISTED }))
  })

  it('writes a model id that is not in the list, keeping the provider', async () => {
    const onUpdateNode = renderPanel(LISTED)
    const list = await openPicker()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'ft:gpt-4o:acme' } })
    fireEvent.click(within(list).getByRole('option', { name: /Use model id "ft:gpt-4o:acme"/ }))

    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_1', expect.objectContaining({
      providerId: 'prov-1',
      providerName: 'OpenAI',
      providerType: 'openai',
      model: 'ft:gpt-4o:acme',
    }))
  })
})
