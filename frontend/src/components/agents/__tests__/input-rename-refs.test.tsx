/**
 * Renaming an Input field (message -> invoices) left `{{input.message}}` in
 * the steps after it, and nothing said so: the run read an empty value.
 * The builder's "To finish" list now names every step that reads a field
 * the Input step no longer has, or a step that was deleted; and the Input
 * step's panel offers, inline, to point the readers at the new name.
 */
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { NodeConfigPanel } from '../node-config-panel'
import { brokenRefs, renameInputRefs } from '../step-values'
import { validateWorkflowGraph, workflowIssues } from '../builder/validate-graph'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]), getModels: vi.fn().mockResolvedValue([]) },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))
vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))
vi.mock('@/components/JsonSchemaBuilder', () => ({ JsonSchemaBuilder: () => null }))
vi.mock('@/components/ui/code-editor', () => ({ CodeEditor: () => null }))

const node = (type: string, id: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data })

const input = (field: string) => node('input', 'input_1', { schema: { type: 'object', properties: { [field]: { type: 'string' } } } })
const llm = node('llm_call', 'llm_1', { providerId: 'p', prompt: 'Sum up {{input.message}} please', messages: [{ content: '{{input.message.0}}' }] })
const output = node('output', 'output_1', { mapping: '{{nodes.llm_1.output}}' })
const edges = [
  { source: 'input_1', target: 'llm_1' },
  { source: 'llm_1', target: 'output_1' },
]

describe('references that point at nothing', () => {
  it('finds a read of a renamed input field and of a deleted step', () => {
    expect(brokenRefs([input('message'), llm, output])).toEqual([])
    expect(brokenRefs([input('invoices'), llm, output]).map((r) => r.path)).toEqual(['input.message', 'input.message.0'])
    // Delete the model call: the Output still reads it.
    expect(brokenRefs([input('message'), output])).toEqual([{ nodeId: 'output_1', path: 'nodes.llm_1.output', kind: 'step' }])
  })

  it('does not flag input reads when the Input step declares no fields (a run may be given anything)', () => {
    expect(brokenRefs([node('input', 'input_1', {}), llm])).toEqual([])
  })

  it('lists both under "To finish" without holding the save back', () => {
    const issues = workflowIssues([input('invoices'), output], [{ source: 'input_1', target: 'output_1' }])
    const texts = issues.map((i) => i.text)
    expect(texts).toContain('Output: reads llm_1 › Result, a step that no longer exists')
    const renamed = workflowIssues([input('invoices'), llm, output], edges, { hasDefaultRouting: true })
    expect(renamed.map((i) => i.text)).toContain('Model call: reads “message”, which the Input step no longer has')
    expect(renamed.every((i) => i.advisory)).toBe(true)
    expect(validateWorkflowGraph([input('invoices'), llm, output], edges, { hasDefaultRouting: true })).toEqual([])
  })

  it('rewrites every read of the old name, keeping the rest of each reference', () => {
    const [changed] = renameInputRefs([input('invoices'), llm, output], 'message', 'invoices')
    expect(changed.id).toBe('llm_1')
    expect(changed.data).toEqual({
      providerId: 'p',
      prompt: 'Sum up {{input.invoices}} please',
      messages: [{ content: '{{input.invoices.0}}' }],
    })
  })
})

function Builder() {
  const [nodes, setNodes] = useState<Node[]>([input('message'), llm, output])
  const onUpdateNode = (id: string, data: Record<string, unknown>) =>
    setNodes((all) => all.map((n) => (n.id === id ? { ...n, data } : n)))
  return (
    <>
      <NodeConfigPanel node={nodes[0]} nodes={nodes} edges={edges} onUpdateNode={onUpdateNode} onDeleteNode={vi.fn()} onClose={vi.fn()} />
      <pre data-testid="prompt">{String(nodes[1].data.prompt)}</pre>
    </>
  )
}

describe('renaming an Input field', () => {
  it('offers, inline, to point the steps that read the old name at the new one', () => {
    renderWithProviders(<Builder />)
    const name = screen.getByLabelText('Field 1 name')
    // Typed a keystroke at a time: one rename, from the name before typing began.
    for (const value of ['messag', 'invoice', 'invoices']) fireEvent.change(screen.getByLabelText('Field 1 name'), { target: { value } })
    expect(name).toBeInTheDocument()

    const note = screen.getByTestId('input-rename-refs')
    expect(note).toHaveTextContent('1 step still reads “message”, which is now called “invoices”.')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Update it to read “invoices”' }))
    expect(screen.getByTestId('prompt')).toHaveTextContent('Sum up {{input.invoices}} please')
    expect(screen.queryByTestId('input-rename-refs')).not.toBeInTheDocument()
  })
})
