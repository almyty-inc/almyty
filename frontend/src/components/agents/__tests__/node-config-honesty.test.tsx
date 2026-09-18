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
import { screen } from '@testing-library/react'
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

    expect(
      screen.getByText(/does not run the nodes downstream of it once per/i),
    ).toBeInTheDocument()
  })
})

describe('Transform node config', () => {
  it('does not label the expression editor as JavaScript', () => {
    renderPanel(node('transform', { expression: '' }))

    const editor = screen.getByTestId('code-editor')
    expect(editor.getAttribute('data-language')).not.toBe('javascript')
    expect(editor.getAttribute('data-language')).toBe('text')
  })

  it('offers a placeholder the resolver can actually resolve', () => {
    renderPanel(node('transform', { expression: '' }))

    // Date.now() fails the resolver's dot-path whitelist and throws.
    expect(screen.getByTestId('code-editor').getAttribute('data-placeholder')).not.toContain(
      'Date.now',
    )
  })

  it('says plainly that the template is not JavaScript', () => {
    renderPanel(node('transform', { expression: '' }))

    expect(screen.getByText(/a template, not javascript/i)).toBeInTheDocument()
  })
})

describe('Output node config', () => {
  const upstream = node('llm_call', {})

  it('shows the picker placeholder for a hand-written template instead of a stale choice', () => {
    // Both controls edit data.mapping. Bound naively, the picker kept showing
    // the last node picked and overwrote a hand-written template on reopen.
    renderPanel(node('output', { mapping: '{{input.message}}' }), [upstream])

    expect(screen.getByText('Pick an upstream node')).toBeInTheDocument()
    expect(screen.getByLabelText('Template')).toHaveValue('{{input.message}}')
  })

  it('reflects a picked node in the same template field', () => {
    renderPanel(node('output', { mapping: '{{nodes.llm_call_1.output}}' }), [upstream])

    expect(screen.queryByText('Pick an upstream node')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Template')).toHaveValue('{{nodes.llm_call_1.output}}')
  })

  it('says the result is rendered as text', () => {
    renderPanel(node('output', { mapping: '' }), [upstream])

    expect(screen.getByText(/arrives here\s+as JSON text/i)).toBeInTheDocument()
  })
})

describe('Merge node config', () => {
  it('names where the judging call actually gets its model', () => {
    renderPanel(node('merge', { strategy: 'best_of_n' }))

    const copy = document.body.textContent || ''
    expect(copy).not.toMatch(/this agent's default routing policy/i)
    expect(copy).toMatch(/organization's default routing policy/i)
    expect(copy).toMatch(/the run fails at this node/i)
  })
})
