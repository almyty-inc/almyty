/**
 * The builder's rules have to be the server's rules.
 *
 * Each case here is a graph `AgentValidationHelper.validatePipeline` refuses
 * with a 400 and the builder used to let through with Save enabled -- and,
 * at the bottom, the graphs it must keep accepting, so mirroring the server
 * costs nothing that the API would take.
 */
import { describe, it, expect } from 'vitest'

import { validateWorkflowGraph, workflowIssues, type GraphNode, type GraphEdge } from '../validate-graph'

const n = (id: string, type: string, data: Record<string, any> = {}): GraphNode => ({ id, type, data })
const e = (source: string, target: string, sourceHandle?: string): GraphEdge => ({ source, target, sourceHandle })

/** input -> llm -> output, the builder's own default graph. */
const straightLine = {
  nodes: [
    n('input_1', 'input'),
    n('llm_1', 'llm_call', { providerId: 'prov-1' }),
    n('output_1', 'output'),
  ],
  edges: [e('input_1', 'llm_1'), e('llm_1', 'output_1')],
}

describe('rules the server enforces and the builder did not', () => {
  it('refuses a second Input node', () => {
    const errors = validateWorkflowGraph(
      [...straightLine.nodes, n('input_2', 'input')],
      [...straightLine.edges, e('input_2', 'llm_1')],
    )

    expect(errors.join(' ')).toMatch(/Keep one Input step and delete the others/)
  })

  it('refuses a node dragged onto the canvas and never wired up', () => {
    const errors = validateWorkflowGraph(
      [...straightLine.nodes, n('transform_9', 'transform', { expression: '' })],
      straightLine.edges,
    )

    expect(errors).toContain('Transform: connect it, or delete it')
  })

  it('refuses an Output node no edge reaches', () => {
    const errors = validateWorkflowGraph(straightLine.nodes, [e('input_1', 'llm_1')])

    expect(errors.join(' ')).toContain('Output: connect it to the steps before it')
  })

  it('refuses a Condition with one branch, and one with two on the same handle', () => {
    const base = [
      n('input_1', 'input'),
      n('cond_1', 'condition', { expression: 'x' }),
      n('output_1', 'output'),
      n('output_2', 'output'),
    ]

    expect(
      validateWorkflowGraph(base.slice(0, 3), [e('input_1', 'cond_1'), e('cond_1', 'output_1', 'true')])
        .join(' '),
    ).toMatch(/Condition: connect a True path and a False path/)

    expect(
      validateWorkflowGraph(base, [
        e('input_1', 'cond_1'),
        e('cond_1', 'output_1', 'true'),
        e('cond_1', 'output_2', 'true'),
      ]).join(' '),
    ).toMatch(/Condition: connect a True path and a False path/)
  })

  it('refuses a Merge fed by one step and a Parallel that fans out to one', () => {
    const merge = validateWorkflowGraph(
      [n('input_1', 'input'), n('merge_1', 'merge', { strategy: 'first_response' }), n('output_1', 'output')],
      [e('input_1', 'merge_1'), e('merge_1', 'output_1')],
    )
    expect(merge.join(' ')).toMatch(/Merge: connect at least two steps into it/)

    const parallel = validateWorkflowGraph(
      [n('input_1', 'input'), n('par_1', 'parallel'), n('output_1', 'output')],
      [e('input_1', 'par_1'), e('par_1', 'output_1')],
    )
    expect(parallel.join(' ')).toMatch(/Parallel: connect at least two steps out of it/)
  })

  it('refuses a Tool call with no tool and a Sub-agent with no agent', () => {
    const errors = validateWorkflowGraph(
      [
        n('input_1', 'input'),
        n('tool_1', 'tool_call', { toolId: '' }),
        n('sub_1', 'sub_agent', { agentId: '' }),
        n('output_1', 'output'),
      ],
      [e('input_1', 'tool_1'), e('tool_1', 'sub_1'), e('sub_1', 'output_1')],
    )

    expect(errors.join(' ')).toMatch(/Tool call: pick a tool/)
    expect(errors.join(' ')).toMatch(/Sub-agent: pick an agent/)
  })

  it('refuses a Verify node with no checkers, a checker naming nothing, and an unknown policy', () => {
    const graph = (data: Record<string, any>) =>
      validateWorkflowGraph(
        [n('input_1', 'input'), n('verify_1', 'verify', data), n('output_1', 'output')],
        [e('input_1', 'verify_1'), e('verify_1', 'output_1')],
      ).join(' ')

    expect(graph({ checkers: [] })).toMatch(/Verify: add a checker/)
    expect(graph({ checkers: [{ name: 'a' }] })).toMatch(/Verify: pick a model for checker 1/)
    expect(graph({ checkers: [{ roleKey: 'v' }], policy: 'best_effort' })).toMatch(/Verify: choose how the checkers' verdicts are combined/)
  })

  it('refuses a cycle', () => {
    const errors = validateWorkflowGraph(
      [
        n('input_1', 'input'),
        n('a', 'transform', { expression: '' }),
        n('b', 'transform', { expression: '' }),
        n('output_1', 'output'),
      ],
      [e('input_1', 'a'), e('a', 'b'), e('b', 'a'), e('a', 'output_1')],
    )

    expect(errors.join(' ')).toMatch(/loop back on each other: remove the connection that goes backwards/)
    // A cycle already explains why those nodes look unreachable; saying it
    // twice is noise.
    expect(errors.join(' ')).not.toMatch(/connect it, or delete it/)
  })
})

describe('graphs the server takes, which the builder must keep taking', () => {
  it('accepts the default straight-line pipeline', () => {
    expect(validateWorkflowGraph(straightLine.nodes, straightLine.edges)).toEqual([])
  })

  it('accepts a compiled graph whose model calls and checkers name roles', () => {
    const errors = validateWorkflowGraph(
      [
        n('input', 'input'),
        n('draft', 'llm_call', { roleKey: 'drafter' }),
        n('check', 'verify', { checkers: [{ name: 'verifier', roleKey: 'verifier' }] }),
        n('gate', 'condition', { expression: 'x' }),
        n('escalate', 'llm_call', { roleKey: 'principal' }),
        n('output', 'output'),
      ],
      [
        e('input', 'draft'),
        e('draft', 'check'),
        e('check', 'gate'),
        e('gate', 'escalate', 'false'),
        e('gate', 'output', 'true'),
        e('escalate', 'output'),
      ],
    )

    expect(errors).toEqual([])
  })

  it('accepts two Output nodes on opposite branches of a Condition', () => {
    const errors = validateWorkflowGraph(
      [
        n('input_1', 'input'),
        n('cond_1', 'condition', { expression: 'x' }),
        n('output_1', 'output'),
        n('output_2', 'output'),
      ],
      [e('input_1', 'cond_1'), e('cond_1', 'output_1', 'true'), e('cond_1', 'output_2', 'false')],
    )

    expect(errors).toEqual([])
  })

  it('still asks a Model call that names nothing at all to say which model it uses', () => {
    const errors = validateWorkflowGraph(
      [n('input_1', 'input'), n('llm_1', 'llm_call', {}), n('output_1', 'output')],
      [e('input_1', 'llm_1'), e('llm_1', 'output_1')],
    )

    expect(errors).toEqual(['Model call: pick a model'])
  })

  // The strings are the product. The builder used to say
  //   Pick a model for the Model call step "llm_1": choose a provider, or a
  //   routing policy or role to choose one at run time.
  // "llm_1" is an id the canvas never draws, and the tail is our jargon. An
  // item now reads like a to-do: the step as the canvas labels it, then what
  // to do, in words. Which of two Model calls it means is answered by
  // clicking it (nodeIds), never by an id in the text.
  it('reads like a to-do, and never shows a node id', () => {
    const nodes = [
      n('input_1', 'input'),
      n('input_2', 'input'),
      n('llm_1', 'llm_call', {}),
      n('tool_1', 'tool_call', { toolId: '' }),
      n('sub_1', 'sub_agent', { agentId: '' }),
      n('verify_1', 'verify', { checkers: [{ name: 'a' }], policy: 'nope' }),
      n('cond_1', 'condition'),
      n('merge_1', 'merge'),
      n('par_1', 'parallel'),
      n('output_1', 'output'),
    ]
    const errors = validateWorkflowGraph(nodes, [e('llm_1', 'tool_1'), e('tool_1', 'llm_1')])

    expect(errors.length).toBeGreaterThan(8)
    for (const message of errors) {
      for (const node of nodes) expect(message).not.toContain(node.id)
      expect(message).not.toMatch(/routing policy|role to choose|found \d|edges?\b|handle/i)
      expect(message).toMatch(
        /^((Input|Output|Model call|Tool call|Sub-agent|Verify|Condition|Merge|Parallel|Transform|Loop|Decision|Extract context)( and [A-Za-z -]+)?(: [a-z]| loop back)|Add |Keep )/,
      )
    }
  })

  it('ties each item to the nodes it is about, so the builder can take the user there', () => {
    const issues = workflowIssues(
      [n('input_1', 'input'), n('llm_a', 'llm_call', {}), n('llm_b', 'llm_call', {}), n('output_1', 'output')],
      [e('input_1', 'llm_a'), e('llm_a', 'llm_b'), e('llm_b', 'output_1')],
    )

    expect(issues).toEqual([
      { text: 'Model call: pick a model', nodeIds: ['llm_a'] },
      { text: 'Model call: pick a model', nodeIds: ['llm_b'] },
    ])
  })

  // A node the user has named is called by that name; the id is only ever
  // the fallback, because the canvas never draws the id at all.
  it('calls a node by its label when it has one', () => {
    const errors = validateWorkflowGraph(
      [
        n('input_1', 'input'),
        n('llm_1', 'llm_call', { label: 'Draft the reply' }),
        n('output_1', 'output'),
      ],
      [e('input_1', 'llm_1'), e('llm_1', 'output_1')],
    )

    expect(errors.join(' ')).toMatch(/^Draft the reply: pick a model$/m)
    expect(errors.join(' ')).not.toMatch(/llm_1/)
  })
})
