/**
 * What the config panel writes back has to be what the node keeps.
 *
 * Two ways it did not:
 *
 * 1. The Condition editor's visual builder held the source/operator/value in
 *    component state seeded once from the node it first rendered for. The
 *    panel is not remounted when you click a different node of the same type
 *    (the Model Call editor carries a `key={node.id}` for exactly this
 *    reason), so clicking a second condition node and touching its Value box
 *    rebuilt the expression around the FIRST node's source.
 *
 * 2. The Sub-Agent editor wrote `agentId` and `agentName` in two consecutive
 *    `updateData` calls. Both spread the same `node.data` prop -- React has
 *    not re-rendered between them -- and `onUpdateNode` replaces `data`
 *    wholesale, so the second write dropped the id that the first had just
 *    set. Picking an agent left the node named but unrunnable.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { NodeConfigPanel } from '../node-config-panel'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]), getModels: vi.fn().mockResolvedValue([]) },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([{ id: 'agent-9', name: 'Researcher' }]) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))
vi.mock('@/components/JsonSchemaBuilder', () => ({ JsonSchemaBuilder: () => null }))
vi.mock('@/components/ui/code-editor', () => ({
  CodeEditor: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="code-editor" value={value || ''} onChange={(e) => onChange?.(e.target.value)} />
  ),
}))

// Radix's Select needs pointer APIs jsdom does not implement. What the panel
// WRITES when a choice is made is the subject here, so drive the same
// onValueChange through a native select.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  return {
    Select: ({ value, onValueChange, children }: any) =>
      React.createElement(
        'select',
        { value: value ?? '', onChange: (e: any) => onValueChange?.(e.target.value) },
        React.createElement('option', { value: '' }, '--'),
        children,
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => React.createElement(React.Fragment, null, children),
    SelectItem: ({ value }: any) => React.createElement('option', { value }, value),
  }
})

const node = (type: string, id: string, data: Record<string, unknown> = {}): Node => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
})

describe('Condition node config', () => {
  it('rebuilds the expression around the node on screen, not the one shown before it', () => {
    const onUpdateNode = vi.fn()
    const first = node('condition', 'cond_a', { expression: "{{nodes.a.output}} === 'x'" })
    const second = node('condition', 'cond_b', { expression: "{{nodes.b.output}} === 'y'" })

    const { rerender } = renderWithProviders(
      <NodeConfigPanel
        node={first}
        nodes={[first, second]}
        onUpdateNode={onUpdateNode}
        onDeleteNode={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    // Click the other condition node: same component, same slot -- React
    // reconciles rather than remounting.
    rerender(
      <NodeConfigPanel
        node={second}
        nodes={[first, second]}
        onUpdateNode={onUpdateNode}
        onDeleteNode={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'z' } })

    expect(onUpdateNode).toHaveBeenCalledWith('cond_b', expect.objectContaining({
      expression: "{{nodes.b.output}} === 'z'",
    }))
  })
})

describe('Sub-Agent node config', () => {
  it('keeps the agent id and the agent name in one write', async () => {
    const onUpdateNode = vi.fn()
    const subAgent = node('sub_agent', 'sub_1', { agentId: '', agentName: '', inputMapping: [] })

    const { container } = renderWithProviders(
      <NodeConfigPanel
        node={subAgent}
        nodes={[subAgent]}
        onUpdateNode={onUpdateNode}
        onDeleteNode={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(container.querySelector('option[value="agent-9"]')).toBeInTheDocument(),
    )

    fireEvent.change(container.querySelector('select')!, { target: { value: 'agent-9' } })

    // onUpdateNode replaces `data` wholesale, so the LAST write is the node.
    const last = onUpdateNode.mock.calls.at(-1)!
    expect(last[0]).toBe('sub_1')
    expect(last[1]).toMatchObject({ agentId: 'agent-9', agentName: 'Researcher' })
  })
})
