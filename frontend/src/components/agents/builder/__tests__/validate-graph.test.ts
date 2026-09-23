/**
 * The builder's rules have to be the server's rules.
 *
 * Each case here is a graph `AgentValidationHelper.validatePipeline` refuses
 * with a 400 and the builder used to let through with Save enabled -- and,
 * at the bottom, the graphs it must keep accepting, so mirroring the server
 * costs nothing that the API would take.
 */
import { describe, it, expect } from 'vitest'

import { validateWorkflowGraph, type GraphNode, type GraphEdge } from '../validate-graph'

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

    expect(errors.join(' ')).toMatch(/exactly one Input node, found 2/i)
  })

  it('refuses a node dragged onto the canvas and never wired up', () => {
    const errors = validateWorkflowGraph(
      [...straightLine.nodes, n('transform_9', 'transform', { expression: '' })],
      straightLine.edges,
    )

    expect(errors.join(' ')).toMatch(/"transform_9" is not connected/i)
    expect(errors.join(' ')).toMatch(/still runs, first, and is still billed/i)
  })

  it('refuses an Output node no edge reaches', () => {
    const errors = validateWorkflowGraph(straightLine.nodes, [e('input_1', 'llm_1')])

    expect(errors.join(' ')).toMatch(/"output_1" cannot be reached/i)
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
    ).toMatch(/exactly 2 outgoing edges, found 1/i)

    expect(
      validateWorkflowGraph(base, [
        e('input_1', 'cond_1'),
        e('cond_1', 'output_1', 'true'),
        e('cond_1', 'output_2', 'true'),
      ]).join(' '),
    ).toMatch(/one edge from the True handle and one from the False handle/i)
  })

  it('refuses a Merge fed by one step and a Parallel that fans out to one', () => {
    const merge = validateWorkflowGraph(
      [n('input_1', 'input'), n('merge_1', 'merge', { strategy: 'first_response' }), n('output_1', 'output')],
      [e('input_1', 'merge_1'), e('merge_1', 'output_1')],
    )
    expect(merge.join(' ')).toMatch(/Merge node "merge_1" must have at least 2 incoming edges, found 1/i)

    const parallel = validateWorkflowGraph(
      [n('input_1', 'input'), n('par_1', 'parallel'), n('output_1', 'output')],
      [e('input_1', 'par_1'), e('par_1', 'output_1')],
    )
    expect(parallel.join(' ')).toMatch(/Parallel node "par_1" must have at least 2 outgoing edges, found 1/i)
  })

  it('refuses a Tool Call with no tool and a Sub-Agent with no agent', () => {
    const errors = validateWorkflowGraph(
      [
        n('input_1', 'input'),
        n('tool_1', 'tool_call', { toolId: '' }),
        n('sub_1', 'sub_agent', { agentId: '' }),
        n('output_1', 'output'),
      ],
      [e('input_1', 'tool_1'), e('tool_1', 'sub_1'), e('sub_1', 'output_1')],
    )

    expect(errors.join(' ')).toMatch(/Choose a tool for the Tool Call step "tool_1"/i)
    expect(errors.join(' ')).toMatch(/Choose an agent for the Sub-Agent step "sub_1"/i)
  })

  it('refuses a Verify node with no checkers, a checker naming nothing, and an unknown policy', () => {
    const graph = (data: Record<string, any>) =>
      validateWorkflowGraph(
        [n('input_1', 'input'), n('verify_1', 'verify', data), n('output_1', 'output')],
        [e('input_1', 'verify_1'), e('verify_1', 'output_1')],
      ).join(' ')

    expect(graph({ checkers: [] })).toMatch(/Add at least one checker to the Verify step/i)
    expect(graph({ checkers: [{ name: 'a' }] })).toMatch(
      /Choose a provider or a role for checker #1 of the Verify step/i,
    )
    expect(graph({ checkers: [{ roleKey: 'v' }], policy: 'best_effort' })).toMatch(
      /unknown merge policy "best_effort"/i,
    )
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

    expect(errors.join(' ')).toMatch(/contains a cycle/i)
    // A cycle already explains why those nodes look unreachable; saying it
    // twice is noise.
    expect(errors.join(' ')).not.toMatch(/is not connected/i)
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

  it('still asks a Model Call that names nothing at all to say which model it uses', () => {
    const errors = validateWorkflowGraph(
      [n('input_1', 'input'), n('llm_1', 'llm_call', {}), n('output_1', 'output')],
      [e('input_1', 'llm_1'), e('llm_1', 'output_1')],
    )

    expect(errors).toEqual([
      'Pick a model for the Model Call step "llm_1": choose a provider, or a routing policy or role to choose one at run time.',
    ])
  })

  // The strings are the product here as much as the rules are: a new user
  // who reads one has to learn what to do next from it, not only what the
  // graph is missing. Three internal nouns and a node id taught them
  // nothing, so every message that reports a gap opens with the verb.
  it('phrases every gap as the step that closes it', () => {
    const errors = validateWorkflowGraph(
      [
        n('llm_1', 'llm_call', {}),
        n('tool_1', 'tool_call', { toolId: '' }),
        n('sub_1', 'sub_agent', { agentId: '' }),
        n('verify_1', 'verify', { checkers: [{ name: 'a' }] }),
      ],
      [],
    )

    expect(errors.length).toBeGreaterThan(0)
    for (const message of errors) {
      expect(message).toMatch(/^(Add|Pick|Choose|Connect|Give|Write)\b/)
    }
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

    expect(errors.join(' ')).toMatch(/"Draft the reply"/)
    expect(errors.join(' ')).not.toMatch(/llm_1/)
  })
})
