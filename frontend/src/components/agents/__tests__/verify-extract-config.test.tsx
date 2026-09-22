/**
 * Every node type you can drag onto the canvas has to be one you can fill in.
 *
 * `verify` and `extract_context` render on the canvas and carry real config
 * the executor reads -- an ejected `cascade` or `explore_extract_patch` graph
 * is made of them -- but the config panel had no branch for either, so
 * clicking one showed a node id and a Delete button and nothing else. They
 * were kept out of the palette to limit the damage, which left the two node
 * types reachable only by ejecting a strategy and uneditable once there.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { NodeConfigPanel } from '../node-config-panel'
import { nodeTypes } from '../nodes'
import { getDefaultData } from '../builder/use-agent-pipeline'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: {
    getAll: vi.fn().mockResolvedValue([{ id: 'prov-1', name: 'OpenAI', type: 'openai' }]),
    getModels: vi.fn().mockResolvedValue([]),
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

vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))
vi.mock('@/components/JsonSchemaBuilder', () => ({ JsonSchemaBuilder: () => null }))
vi.mock('@/components/ui/code-editor', () => ({ CodeEditor: () => <div data-testid="code-editor" /> }))

const panelSource = readFileSync(
  resolve(__dirname, '../node-config-panel.tsx'),
  'utf8',
)
const paletteSource = readFileSync(resolve(__dirname, '../node-palette.tsx'), 'utf8')

function renderPanel(node: Node) {
  const onUpdateNode = vi.fn()
  const view = renderWithProviders(
    <NodeConfigPanel
      node={node}
      nodes={[node]}
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

describe('the config panel covers every node type the canvas renders', () => {
  it.each(Object.keys(nodeTypes))('has a config branch for %s', (type) => {
    expect(panelSource).toContain(`nodeType === '${type}'`)
  })

  it.each(Object.keys(nodeTypes))('offers %s in the palette', (type) => {
    expect(paletteSource).toContain(`'${type}',`)
  })

  it.each(Object.keys(nodeTypes))('seeds %s with default data on drop', (type) => {
    expect(getDefaultData(type as any)).toBeTypeOf('object')
  })
})

describe('Verify node config', () => {
  it('adds a checker to the list the executor reads', () => {
    const { onUpdateNode } = renderPanel(node('verify', { checkers: [], policy: 'any_fail_blocks' }))

    fireEvent.click(screen.getByRole('button', { name: /add checker/i }))

    expect(onUpdateNode).toHaveBeenCalledWith(
      'verify_1',
      expect.objectContaining({ checkers: [expect.objectContaining({ name: '' })] }),
    )
  })

  it('keeps a compiled checker on its role when another field is edited', () => {
    const { onUpdateNode } = renderPanel(
      node('verify', { checkers: [{ name: 'verifier', roleKey: 'verifier' }] }),
    )

    fireEvent.change(screen.getByLabelText('Checker 1 name'), { target: { value: 'reviewer' } })

    expect(onUpdateNode).toHaveBeenCalledWith(
      'verify_1',
      expect.objectContaining({
        checkers: [{ name: 'reviewer', roleKey: 'verifier' }],
      }),
    )
  })

  it('says the node does not fail the run on a bad verdict', () => {
    renderPanel(node('verify', { checkers: [] }))

    expect(screen.getByText(/never fails the run on a bad verdict/i)).toBeInTheDocument()
  })
})

describe('Extract Context node config', () => {
  it('writes the keys the executor reads', () => {
    const { onUpdateNode } = renderPanel(node('extract_context', {}))

    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'fix the bug' } })
    expect(onUpdateNode).toHaveBeenCalledWith('extract_context_1', expect.objectContaining({ task: 'fix the bug' }))

    fireEvent.change(screen.getByLabelText('Sources'), { target: { value: '{{nodes.a.output}}' } })
    expect(onUpdateNode).toHaveBeenCalledWith(
      'extract_context_1',
      expect.objectContaining({ sources: '{{nodes.a.output}}' }),
    )

    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'be terse' } })
    expect(onUpdateNode).toHaveBeenCalledWith(
      'extract_context_1',
      expect.objectContaining({ instruction: 'be terse' }),
    )
  })

  it('shows the role rather than an empty provider picker on a compiled node', async () => {
    renderPanel(node('extract_context', { roleKey: 'explorer' }))

    await waitFor(() => expect(screen.getByText('explorer')).toBeInTheDocument())
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument()
  })
})

describe('an unset template field stays unset', () => {
  // The executor branches on presence, not truthiness: `config.target !==
  // undefined` for verify, and for extract_context an empty `sources` fails
  // the node outright while an empty `instruction` replaces the built-in
  // extraction prompt with nothing. So an emptied box has to write `undefined`,
  // and a freshly dropped node must not seed those keys at all.
  it('does not seed verify with a target or extract_context with sources', () => {
    expect(getDefaultData('verify' as any)).not.toHaveProperty('target')
    expect(getDefaultData('extract_context' as any)).not.toHaveProperty('sources')
    expect(getDefaultData('extract_context' as any)).not.toHaveProperty('instruction')
  })

  it('clears the verify target back to undefined rather than an empty string', () => {
    const { onUpdateNode } = renderPanel(node('verify', { checkers: [], target: '{{nodes.a.output}}' }))

    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '' } })

    expect(onUpdateNode).toHaveBeenCalledWith('verify_1', expect.objectContaining({ target: undefined }))
  })

  it('clears the extract_context sources and instruction back to undefined', () => {
    const { onUpdateNode } = renderPanel(
      node('extract_context', { sources: '{{nodes.a.output}}', instruction: 'be terse' }),
    )

    fireEvent.change(screen.getByLabelText('Sources'), { target: { value: '' } })
    expect(onUpdateNode).toHaveBeenCalledWith(
      'extract_context_1',
      expect.objectContaining({ sources: undefined }),
    )

    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: '' } })
    expect(onUpdateNode).toHaveBeenCalledWith(
      'extract_context_1',
      expect.objectContaining({ instruction: undefined }),
    )
  })
})
