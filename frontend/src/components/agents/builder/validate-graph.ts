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
 * Model Call check, which the server has no case for -- it stays a warning
 * about a node that would fail at run time, and it still accepts a node
 * that names a role.
 */

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

/** Every reason the graph as drawn cannot be saved, in the order a reader meets them. */
export function validateWorkflowGraph(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const errors: string[] = []

  const inputs = nodes.filter((n) => n.type === 'input')
  const outputs = nodes.filter((n) => n.type === 'output')

  if (inputs.length === 0) {
    errors.push('Pipeline must have at least one Input node')
  } else if (inputs.length > 1) {
    // The server wants exactly one; the builder used to say "at least one",
    // so a second Input node passed here and 400'd on save.
    errors.push(
      `Pipeline must have exactly one Input node, found ${inputs.length} (${inputs.map((n) => n.id).join(', ')})`,
    )
  }
  if (outputs.length === 0) {
    errors.push('Pipeline must have at least one Output node')
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
        if (!data.providerId && !data.routing && !data.roleKey) {
          errors.push(
            `Model Call node "${node.id}" is missing a provider, a routing policy, or a role`,
          )
        }
        break

      case 'condition': {
        if (out.length !== 2) {
          errors.push(
            `Condition node "${node.id}" must have exactly 2 outgoing edges, found ${out.length}`,
          )
          break
        }
        const handles = out.map(branchHandle)
        const trueFalse =
          (handles.includes('true') && handles.includes('false')) ||
          (handles.includes('yes') && handles.includes('no'))
        if (!trueFalse) {
          errors.push(
            `Condition node "${node.id}" needs one edge from the True handle and one from the False handle`,
          )
        }
        break
      }

      case 'merge':
        if (inc.length < 2) {
          errors.push(
            `Merge node "${node.id}" must have at least 2 incoming edges, found ${inc.length}`,
          )
        }
        break

      case 'parallel':
        if (out.length < 2) {
          errors.push(
            `Parallel node "${node.id}" must have at least 2 outgoing edges, found ${out.length}`,
          )
        }
        break

      case 'tool_call':
        if (!data.toolId) {
          errors.push(`Tool Call node "${node.id}" is missing a tool`)
        }
        break

      case 'sub_agent':
        if (!data.agentId && !data.target) {
          errors.push(`Sub-Agent node "${node.id}" is missing an agent`)
        }
        break

      case 'verify': {
        const checkers = Array.isArray(data.checkers) ? data.checkers : []
        if (checkers.length === 0) {
          errors.push(`Verify node "${node.id}" needs at least one checker`)
        }
        checkers.forEach((checker: any, i: number) => {
          if (!checker || (!checker.providerId && !checker.roleKey)) {
            errors.push(
              `Verify node "${node.id}" checker #${i + 1} is missing a provider or a role`,
            )
          }
        })
        if (data.policy && !VERIFY_POLICIES.includes(data.policy)) {
          errors.push(`Verify node "${node.id}" has an unknown merge policy "${data.policy}"`)
        }
        break
      }
    }
  }

  const cyclic = nodesInCycle(nodes, edges)
  if (cyclic.length) {
    errors.push(
      `Pipeline contains a cycle through ${cyclic.map((id) => `"${id}"`).join(', ')}. A pipeline runs forward only.`,
    )
  }

  // Reachability only means something once there is exactly one starting
  // point, and a cycle makes "unreachable" a second way of saying the same
  // thing, so both are reported once rather than twice.
  if (inputs.length === 1 && !cyclic.length) {
    const visited = reachableFrom(inputs[0].id, nodes, edges)
    if (outputs.length && !outputs.some((o) => visited.has(o.id))) {
      errors.push(
        `Output node${outputs.length === 1 ? '' : 's'} ${outputs.map((o) => `"${o.id}"`).join(', ')} cannot be reached from "${inputs[0].id}". Connect ${outputs.length === 1 ? 'it' : 'them'} with an edge.`,
      )
    }
    const orphans = nodes.filter((n) => !visited.has(n.id))
    if (orphans.length) {
      errors.push(
        `${orphans.map((n) => `"${n.id}"`).join(', ')} ${orphans.length === 1 ? 'is' : 'are'} not connected to "${inputs[0].id}". Wire ${orphans.length === 1 ? 'it' : 'them'} up or delete ${orphans.length === 1 ? 'it' : 'them'} — an unconnected node still runs, first, and is still billed.`,
      )
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
