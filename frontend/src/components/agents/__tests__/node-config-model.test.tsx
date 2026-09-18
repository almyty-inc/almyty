/**
 * The LLM node's Model field.
 *
 * Radix renders a Select's placeholder whenever `value` matches no SelectItem,
 * and it does so silently. The items here come from the provider's live model
 * list, so a saved model that list does not return -- a dated snapshot id, a
 * fine-tune, a retired model -- used to read as "Select model" while the node
 * still held and executed the saved value. These tests pin both guards: the
 * field opens in free-text mode when the saved model is not listed, and the
 * saved value stays selectable if the user switches back to the suggestions.
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

function renderPanel(model: string) {
  const node = llmNode(model)
  return renderWithProviders(
    <NodeConfigPanel
      node={node}
      nodes={[node]}
      onUpdateNode={vi.fn()}
      onDeleteNode={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

describe('LLM node model field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getModels).mockResolvedValue([{ id: LISTED }] as any)
  })

  it('shows a saved model the provider does not list instead of a blank placeholder', async () => {
    renderPanel(SAVED_BUT_UNLISTED)

    // Wait for the provider's list to land first. The toggle renders only
    // once there are suggestions, so its presence is the signal that the
    // Select branch is now live -- assert before that and the field is still
    // in its loading fallback and the test passes for the wrong reason.
    // That it reads "Use suggested" is itself the fix: the field opened in
    // custom mode because the saved model is not in the list.
    expect(await screen.findByRole('button', { name: 'Use suggested' })).toBeInTheDocument()

    // The saved value is on screen and editable, not swallowed by a Select
    // that has no item for it.
    expect(screen.getByDisplayValue(SAVED_BUT_UNLISTED)).toBeInTheDocument()
    expect(screen.queryByText('Select model')).not.toBeInTheDocument()
  })

  it('offers the saved value as an option when the user switches back to suggestions', async () => {
    renderPanel(SAVED_BUT_UNLISTED)

    // The toggle only appears once suggestions have loaded; it reads
    // "Use suggested" precisely because the field defaulted to custom.
    const toggle = await screen.findByRole('button', { name: 'Use suggested' })
    fireEvent.click(toggle)

    // Radix keeps closed content mounted off-screen so the selected item's
    // text reaches the trigger -- which is exactly what was missing before.
    await waitFor(() => expect(screen.getByText(SAVED_BUT_UNLISTED)).toBeInTheDocument())
    expect(screen.queryByText('Select model')).not.toBeInTheDocument()
  })

  it('uses the suggestion list when the saved model is one of the suggestions', async () => {
    renderPanel(LISTED)

    expect(await screen.findByRole('button', { name: 'Custom model' })).toBeInTheDocument()
    expect(screen.queryByDisplayValue(LISTED)).not.toBeInTheDocument()
  })
})
