/**
 * The builder's copy of the rules the server enforces on a saved pipeline.
 *
 * `AgentValidationHelper.validatePipeline` refuses a graph for a dozen
 * reasons; the builder checked two of them. Everything else -- a second
 * Input node, a Condition with one branch, a Merge fed by one step, a Tool
 * Call with no tool, a cycle, and above all a node dragged onto the canvas
 * and never wired to anything -- left Save enabled, and the only feedback
 * was a 400 toast after the round trip.
 *
 * These mirror the server rather than adding to it: everything here is a
 * reason the server would reject the save anyway, so nothing that the API
 * accepts becomes unsaveable. The one rule that is the builder's own is the
 * Model call check, which the server has no case for -- it stays a warning
 * about a node that would fail at run time, and it still accepts a node
 * that names a role.
 */

import { STEP_NAMES } from '../step-values'

export interface GraphNode {
  id: string
  type?: string
  data?: Record<string, any>
}

export interface GraphEdge {
  source: string
  target: string
  sourceHandle?: string | null
  label?: unknown
}

const VERIFY_POLICIES = ['all_pass', 'majority', 'any_fail_blocks']

function branchHandle(edge: GraphEdge): string {
  return String(edge.sourceHandle || edge.label || '')
}

/**
 * What a person sees on the canvas: each node is drawn with its type as the
 * header ("Model call", "Tool call") and never its id. Messages used to say
 * `Pick a model for the Model call step "llm_1"` -- naming the node by an id
 * the reader had never seen. A node the user has labelled is called by that
 * label; otherwise by the header it is drawn with, which is `STEP_NAMES`:
 * one list for the palette, the canvas, the side panel and these messages.
 * Which of several Model calls an item means is answered by clicking it.
 */

export function stepName(node: GraphNode): string {
  const label = typeof node.data?.label === 'string' ? node.data.label.trim() : ''
  return label || STEP_NAMES[node.type || ''] || 'Step'
}

/**
 * One thing left to do. `nodeIds` are the nodes it is about, so the builder
 * can outline them and take the user to them; the ids never reach the text.
 */
export interface BuilderIssue {
  text: string
  nodeIds: string[]
}

function joinNames(names: string[]): string {
  const unique = [...new Set(names)]
  if (unique.length <= 1) return unique[0] || ''
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`
}

/** Every reason the graph as drawn cannot be saved, in the order a reader meets them. */
/**
 * `hasDefaultRouting` is whether the organization sets settings.defaultRouting.
 * When it does, the engine resolves an llm_call node that names neither a
 * provider nor a policy (agent-node-executor.callModelForNode), and the
 * server's validator has no llm_call rule at all -- so refusing to save such
 * a graph was the builder refusing something the API accepts and the engine
 * runs. Every other rule here mirrors the server.
 */
export function validateWorkflowGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: { hasDefaultRouting?: boolean } = {},
): string[] {
  return workflowIssues(nodes, edges, options).map((issue) => issue.text)
}

/** The same checks, each tied to the nodes it is about. */
export function workflowIssues(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: { hasDefaultRouting?: boolean } = {},
): BuilderIssue[] {
  const errors: BuilderIssue[] = []
  const add = (text: string, ...about: GraphNode[]) =>
    errors.push({ text, nodeIds: about.map((n) => n.id) })

  const inputs = nodes.filter((n) => n.type === 'input')
  const outputs = nodes.filter((n) => n.type === 'output')

  if (inputs.length === 0) {
    add('Add an Input step')
  } else if (inputs.length > 1) {
    // The server wants exactly one; the builder used to say "at least one",
    // so a second Input node passed here and 400'd on save.
    add('Keep one Input step and delete the others', ...inputs)
  }
  if (outputs.length === 0) {
    add('Add an Output step')
  }

  const outgoing = new Map<string, GraphEdge[]>()
  const incoming = new Map<string, GraphEdge[]>()
  for (const node of nodes) {
    outgoing.set(node.id, [])
    incoming.set(node.id, [])
  }
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge)
    incoming.get(edge.target)?.push(edge)
  }

  for (const node of nodes) {
    const data = node.data || {}
    const out = outgoing.get(node.id) || []
    const inc = incoming.get(node.id) || []

    switch (node.type) {
      // A model call has to say which model it uses, and there are three
      // ways to say it: pin a provider, give a routing policy, or name a
      // role and let the role be filled at run time. A graph ejected from
      // the Execution tab carries `roleKey` and deliberately never a
      // provider -- that portability is the point of the layer.
      case 'llm_call':
        if (!data.providerId && !data.routing && !data.roleKey && !options.hasDefaultRouting) {
          add(`${stepName(node)}: pick a model`, node)
        }
        break

      case 'condition': {
        if (out.length !== 2) {
          add(`${stepName(node)}: connect a True path and a False path`, node)
          break
        }
        const handles = out.map(branchHandle)
        const trueFalse =
          (handles.includes('true') && handles.includes('false')) ||
          (handles.includes('yes') && handles.includes('no'))
        if (!trueFalse) {
          add(`${stepName(node)}: connect a True path and a False path`, node)
        }
        break
      }

      case 'merge':
        if (inc.length < 2) {
          add(`${stepName(node)}: connect at least two steps into it`, node)
        }
        break

      case 'parallel':
        if (out.length < 2) {
          add(`${stepName(node)}: connect at least two steps out of it`, node)
        }
        break

      case 'tool_call':
        if (!data.toolId) {
          add(`${stepName(node)}: pick a tool`, node)
        }
        break

      case 'sub_agent':
        if (!data.agentId && !data.target) {
          add(`${stepName(node)}: pick an agent`, node)
        }
        break

      case 'verify': {
        const checkers = Array.isArray(data.checkers) ? data.checkers : []
        if (checkers.length === 0) {
          add(`${stepName(node)}: add a checker`, node)
        }
        checkers.forEach((checker: any, i: number) => {
          if (!checker || (!checker.providerId && !checker.roleKey)) {
            add(`${stepName(node)}: pick a model for checker ${i + 1}`, node)
          }
        })
        if (data.policy && !VERIFY_POLICIES.includes(data.policy)) {
          add(`${stepName(node)}: choose how the checkers' verdicts are combined`, node)
        }
        break
      }
    }
  }

  const cyclic = nodesInCycle(nodes, edges)
  if (cyclic.length) {
    const looped = nodes.filter((n) => cyclic.includes(n.id))
    add(
      `${joinNames(looped.map(stepName))} loop back on each other: remove the connection that goes backwards`,
      ...looped,
    )
  }

  // Reachability only means something once there is exactly one starting
  // point, and a cycle makes "unreachable" a second way of saying the same
  // thing, so both are reported once rather than twice.
  if (inputs.length === 1 && !cyclic.length) {
    const visited = reachableFrom(inputs[0].id, nodes, edges)
    const unreachableOutputs = outputs.some((o) => visited.has(o.id)) ? [] : outputs
    if (unreachableOutputs.length) {
      add(`${stepName(unreachableOutputs[0])}: connect it to the steps before it`, ...unreachableOutputs)
    }
    // A step nothing leads to still runs -- first, and billed -- so each one
    // is its own item the user can click to find.
    for (const orphan of nodes.filter((n) => !visited.has(n.id) && !unreachableOutputs.includes(n))) {
      add(`${stepName(orphan)}: connect it, or delete it`, orphan)
    }
  }

  return errors
}

function reachableFrom(startId: string, nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const node of nodes) adjacency.set(node.id, [])
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target)

  const visited = new Set<string>()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const neighbor of adjacency.get(id) || []) stack.push(neighbor)
  }
  return visited
}

/** Kahn's algorithm: whatever never drains is exactly what the cycle runs through. */
function nodesInCycle(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const adjacency = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const node of nodes) {
    adjacency.set(node.id, [])
    inDegree.set(node.id, 0)
  }
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !inDegree.has(edge.target)) continue
    adjacency.get(edge.source)!.push(edge.target)
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
  }

  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const sorted = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    sorted.add(id)
    for (const neighbor of adjacency.get(id) || []) {
      const next = (inDegree.get(neighbor) || 0) - 1
      inDegree.set(neighbor, next)
      if (next === 0) queue.push(neighbor)
    }
  }

  return nodes.filter((n) => !sorted.has(n.id)).map((n) => n.id)
}
