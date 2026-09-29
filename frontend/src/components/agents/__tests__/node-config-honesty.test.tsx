/**
 * What the node config panel promises has to be what the executor does.
 *
 * Three claims used to be wrong in a way a user only discovers at runtime,
 * with no error: the Loop node advertised {{loop.item}}/{{loop.index}}, which
 * the executor never exposes and the resolver turns into an empty string; the
 * Transform node called its template JavaScript and offered a placeholder
 * containing Date.now(), which the resolver's dot-path whitelist rejects; and
 * the Merge node's Best of N copy named a routing policy that does not exist.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { NodeConfigPanel } from '../node-config-panel'

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

// The real editor is a CodeMirror instance; the props are what is under test.
vi.mock('@/components/ui/code-editor', () => ({
  CodeEditor: ({ language, placeholder }: { language?: string; placeholder?: string }) => (
    <div data-testid="code-editor" data-language={language} data-placeholder={placeholder} />
  ),
}))

function renderPanel(node: Node, nodes: Node[] = [node]) {
  const onUpdateNode = vi.fn()
  const view = renderWithProviders(
    <NodeConfigPanel
      node={node}
      nodes={nodes}
      onUpdateNode={onUpdateNode}
      onDeleteNode={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return { ...view, onUpdateNode }
}

const node = (type: string, data: Record<string, unknown> = {}): Node => ({
  id: `${type}_1`,
  type,
  position: { x: 0, y: 0 },
  data,
})

describe('Loop node config', () => {
  it('does not promise a loop context the executor never exposes', () => {
    renderPanel(node('loop', { iterableExpression: '{{input.items}}' }))

    expect(document.body.textContent).not.toContain('{{loop.item}}')
    expect(document.body.textContent).not.toContain('{{loop.index}}')
  })

  it('says the node outputs the array rather than running downstream nodes per item', () => {
    renderPanel(node('loop', { iterableExpression: '{{input.items}}' }))

    expect(screen.getByText(/The steps after it run once, on the whole list/i)).toBeInTheDocument()
  })
})

describe('Transform node config', () => {
  it('does not call the template JavaScript, even as text', () => {
    renderPanel(node('transform', { expression: '' }))
    expect(document.body.textContent).not.toMatch(/javascript/i)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Edit values as text' }))
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/javascript/i)
  })

  it('offers a placeholder the resolver can actually resolve', () => {
    renderPanel(node('transform', { expression: '' }))

    // Date.now() fails the resolver's dot-path whitelist and throws.
    expect(screen.getByRole('textbox', { name: 'Result' }).getAttribute('data-placeholder')).not.toContain('Date.now')
  })

  it('says plainly that the result is text', () => {
    renderPanel(node('transform', { expression: '' }))

    expect(screen.getByText(/still arrives downstream as text/i)).toBeInTheDocument()
  })
})

describe('Output node config', () => {
  const upstream = node('llm_call', {})

  it('shows what it answers with by name, one field, no template syntax', () => {
    // One field edits data.mapping. There is no second picker to disagree with it.
    renderPanel(node('output', { mapping: '{{input.message}}' }), [upstream])

    const field = screen.getByRole('textbox', { name: 'What it answers with' })
    expect(field).toHaveTextContent('Input › message')
    expect(field.textContent).not.toContain('{{')
  })

  it('names a picked step the same way', () => {
    renderPanel(node('output', { mapping: '{{nodes.llm_call_1.output}}' }), [upstream])

    expect(screen.getByRole('textbox', { name: 'What it answers with' })).toHaveTextContent('Model call › Answer')
  })

  it('says the result is rendered as text', () => {
    renderPanel(node('output', { mapping: '' }), [upstream])

    expect(screen.getByText(/Arrives as text: an answer that is a list or an object comes as JSON/i)).toBeInTheDocument()
  })
})

describe('Merge node config', () => {
  it('names where the judging call actually gets its model', () => {
    renderPanel(node('merge', { strategy: 'best_of_n' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    const copy = document.body.textContent || ''
    expect(copy).not.toMatch(/this agent's default routing policy/i)
    expect(copy).toMatch(/organization's default routing policy/i)
    expect(copy).toMatch(/the run fails here/i)
  })
})
