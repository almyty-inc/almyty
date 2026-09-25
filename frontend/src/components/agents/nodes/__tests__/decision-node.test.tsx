/**
 * A decision node routes on its answer, so its edges are the feature.
 *
 * `decide` returns a distribution over declared options, not prose. That is
 * only worth anything if the canvas gives each option somewhere to go and
 * gives a below-threshold answer somewhere else to go -- one source handle
 * would collapse the distribution back into "it said something", which is
 * exactly what a Model Call node already does.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { DecisionNode, nodeTypes, NODE_TYPE_CONFIG } from '..'
import { NodeConfigPanel } from '../../node-config-panel'
import { getDefaultData } from '../../builder/use-agent-pipeline'

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
vi.mock('@/components/ui/code-editor', () => ({ CodeEditor: () => <div data-testid="code-editor" /> }))

const nodeProps = {
  selected: false,
  zIndex: 0,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  dragging: false,
} as any

const draw = (ui: React.ReactElement) => render(<ReactFlowProvider>{ui}</ReactFlowProvider>)

const handleIds = (container: HTMLElement, type: 'source' | 'target') =>
  Array.from(container.querySelectorAll(`.react-flow__handle.${type}`)).map((el) =>
    el.getAttribute('data-handleid'),
  )

const question = {
  id: 'billing',
  type: 'choice',
  prompt: 'Is this a billing problem?',
  options: [
    { id: 'billing' },
    { id: 'technical' },
    { id: 'unclear', description: 'The state does not answer this', abstain: true },
  ],
}

describe('Decision node on the canvas', () => {
  it('is a registered node type with a label and a colour', () => {
    expect(nodeTypes.decision).toBeDefined()
    expect(NODE_TYPE_CONFIG.decision.label).toBe('Decision')
    expect(NODE_TYPE_CONFIG.decision.color).toBeTruthy()
  })

  it('takes one state in and gives every option its own edge out', () => {
    const { container } = draw(
      <DecisionNode {...nodeProps} id="decide" type="decision" data={{ question }} />,
    )

    expect(handleIds(container, 'target')).toHaveLength(1)
    // The abstain option is drawn once, under the dedicated abstain handle.
    expect(handleIds(container, 'source')).toEqual(['billing', 'technical', 'abstain'])
    expect(screen.getByText('Is this a billing problem?')).toBeInTheDocument()
  })

  it('keeps the abstain edge even when no option declares one', () => {
    const { container } = draw(
      <DecisionNode
        {...nodeProps}
        id="decide"
        type="decision"
        data={{ question: { type: 'choice', prompt: 'Which?', options: [{ id: 'a' }] } }}
      />,
    )

    expect(handleIds(container, 'source')).toEqual(['a', 'abstain'])
  })

  it('says a boolean question is refused rather than drawing edges it cannot route', () => {
    // The executor throws on a boolean question: it declares no options, so
    // it has no abstain edge and the threshold protects nothing. Drawing
    // true/false handles here would promise routing that never happens.
    const { container } = draw(
      <DecisionNode
        {...nodeProps}
        id="decide"
        type="decision"
        data={{ question: { type: 'boolean', prompt: 'Is it urgent?' } }}
      />,
    )

    expect(handleIds(container, 'source')).toEqual(['abstain'])
    expect(screen.getByText(/boolean is refused/i)).toBeInTheDocument()
  })

  it('shows the threshold an option has to clear', () => {
    draw(
      <DecisionNode
        {...nodeProps}
        id="decide"
        type="decision"
        data={{ question, thresholds: { billing: 0.8 } }}
      />,
    )

    expect(screen.getByText(/0\.8/)).toBeInTheDocument()
  })

  it('says plainly when the question has not been written yet', () => {
    draw(<DecisionNode {...nodeProps} id="decide" type="decision" data={{}} />)

    expect(screen.getByText('No question')).toBeInTheDocument()
    expect(screen.getByText('No options')).toBeInTheDocument()
  })
})

describe('Decision node default data', () => {
  it('drops with its abstain option already declared', () => {
    const data = getDefaultData('decision' as any)
    const options = (data.question as any).options as Array<Record<string, unknown>>

    // validateQuestion refuses a choice question with no abstain option
    // (ABSTAIN_MISSING), so a node seeded without one is unrunnable the
    // moment it is dropped.
    expect(options.filter((o) => o.abstain === true)).toHaveLength(1)
  })

  it('seeds no thresholds, because an unset threshold is not a threshold of zero', () => {
    expect(getDefaultData('decision' as any)).not.toHaveProperty('thresholds')
  })
})

describe('Decision node config', () => {
  const node = (data: Record<string, unknown>): Node => ({
    id: 'decision_1',
    type: 'decision',
    position: { x: 0, y: 0 },
    data,
  })

  const renderPanel = (data: Record<string, unknown>) => {
    const onUpdateNode = vi.fn()
    const view = renderWithProviders(
      <NodeConfigPanel
        node={node(data)}
        nodes={[node(data)]}
        onUpdateNode={onUpdateNode}
        onDeleteNode={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    return { ...view, onUpdateNode }
  }

  it('writes the prompt into the question the backend reads', () => {
    const { onUpdateNode } = renderPanel({ question })

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Is it urgent?' } })

    expect(onUpdateNode).toHaveBeenCalledWith(
      'decision_1',
      expect.objectContaining({
        question: expect.objectContaining({ prompt: 'Is it urgent?', id: 'billing' }),
      }),
    )
  })

  it('writes a per-option threshold, keyed by option id', () => {
    const { onUpdateNode } = renderPanel({ question })

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Answer 1 bar'), { target: { value: '0.75' } })

    expect(onUpdateNode).toHaveBeenCalledWith(
      'decision_1',
      expect.objectContaining({ thresholds: { billing: 0.75 } }),
    )
  })

  it('clears a threshold back to unset rather than to zero', () => {
    const { onUpdateNode } = renderPanel({ question, thresholds: { billing: 0.75 } })

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Answer 1 bar'), { target: { value: '' } })

    expect(onUpdateNode).toHaveBeenCalledWith(
      'decision_1',
      expect.objectContaining({ thresholds: undefined }),
    )
  })

  it('moves the abstain mark rather than allowing two', () => {
    const { onUpdateNode } = renderPanel({ question })

    fireEvent.click(screen.getByLabelText('Answer 2 means cannot tell'))

    const written = onUpdateNode.mock.calls.at(-1)![1] as any
    expect(written.question.options.filter((o: any) => o.abstain === true)).toEqual([
      expect.objectContaining({ id: 'technical' }),
    ])
  })

  it('warns when the question has no abstain option at all', () => {
    renderPanel({ question: { ...question, options: [{ id: 'billing' }] } })

    expect(screen.getByText(/Mark one answer as .cannot tell./i)).toBeInTheDocument()
  })

  // The panel only offers what executeDecisionNode actually serves. It
  // throws by name on a boolean question and on any optionsOrderPolicy but
  // `asis`, so offering either as a choice would hand the user a node that
  // is guaranteed to fail its first run with no warning in the builder.
  it('never offers a choice the step refuses: no yes-or-no kind, no reordering', () => {
    renderPanel({ question: { ...question, type: 'boolean', optionsOrderPolicy: 'permute2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    fireEvent.click(screen.getByLabelText('Kind of question'))
    const kinds = screen.getAllByRole('option').map((o) => o.textContent)
    expect(kinds).toEqual(['Pick one answer', 'Pick one level, in order'])
    expect(document.body.textContent).not.toMatch(/refused by this node/i)
    expect(screen.queryByLabelText('Option order')).not.toBeInTheDocument()
  })

  it('says so on a step that already carries a yes-or-no question', () => {
    renderPanel({ question: { ...question, type: 'boolean' } })

    expect(screen.getByTestId('decision-boolean')).toHaveTextContent('cannot run a yes-or-no question')
  })

  it('says so on a step set to reorder its answers, and puts the written order back', () => {
    const { onUpdateNode } = renderPanel({ question: { ...question, optionsOrderPolicy: 'permute2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.getByTestId('decision-order-policy')).toHaveTextContent('permute2')
    fireEvent.click(screen.getByRole('button', { name: 'Use the written order' }))
    expect(onUpdateNode).toHaveBeenCalledWith('decision_1', expect.objectContaining({ question: expect.objectContaining({ optionsOrderPolicy: 'asis' }) }))
  })
})
