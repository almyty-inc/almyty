import { Injectable, BadRequestException } from '@nestjs/common';
import { AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';

@Injectable()
export class AgentValidationHelper {
  validatePipeline(pipeline: AgentPipeline, agentId?: string): void {
    if (!pipeline || !pipeline.nodes || !pipeline.edges) {
      throw new BadRequestException('Pipeline must have nodes and edges arrays');
    }

    if (!Array.isArray(pipeline.nodes) || !Array.isArray(pipeline.edges)) {
      throw new BadRequestException('Pipeline nodes and edges must be arrays');
    }

    // Check for input nodes
    const inputNodes = pipeline.nodes.filter(n => n.type === 'input');
    if (inputNodes.length !== 1) {
      throw new BadRequestException(`Pipeline must have exactly 1 input node, found ${inputNodes.length}`);
    }

    // Check for output nodes
    const outputNodes = pipeline.nodes.filter(n => n.type === 'output');
    if (outputNodes.length < 1) {
      throw new BadRequestException('Pipeline must have at least 1 output node');
    }

    // Check that node IDs are unique
    const nodeIds = new Set(pipeline.nodes.map(n => n.id));
    if (nodeIds.size !== pipeline.nodes.length) {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const node of pipeline.nodes) {
        if (seen.has(node.id)) duplicates.add(node.id);
        seen.add(node.id);
      }
      throw new BadRequestException(
        `Pipeline node IDs must be unique, but ${[...duplicates].map(id => `'${id}'`).join(', ')} ` +
          `${duplicates.size === 1 ? 'is used' : 'are used'} more than once.`,
      );
    }

    // Check that all edges reference existing nodes
    for (const edge of pipeline.edges) {
      if (!nodeIds.has(edge.source)) {
        throw new BadRequestException(`Edge source '${edge.source}' does not reference an existing node`);
      }
      if (!nodeIds.has(edge.target)) {
        throw new BadRequestException(`Edge target '${edge.target}' does not reference an existing node`);
      }
    }

    // Build edge lookup maps for advanced validation
    const outgoingEdges = new Map<string, AgentPipelineEdge[]>();
    const incomingEdges = new Map<string, AgentPipelineEdge[]>();
    for (const node of pipeline.nodes) {
      outgoingEdges.set(node.id, []);
      incomingEdges.set(node.id, []);
    }
    for (const edge of pipeline.edges) {
      outgoingEdges.get(edge.source)?.push(edge);
      incomingEdges.get(edge.target)?.push(edge);
    }

    // Validate specific node types
    for (const node of pipeline.nodes) {
      switch (node.type) {
        case 'condition': {
          const outEdges = outgoingEdges.get(node.id) || [];
          if (outEdges.length !== 2) {
            throw new BadRequestException(
              `Condition node '${node.id}' must have exactly 2 outgoing edges, found ${outEdges.length}`,
            );
          }
          const handles = outEdges.map(e => e.sourceHandle || e.label || '').sort();
          const hasTrueFalse =
            (handles.includes('true') && handles.includes('false')) ||
            (handles.includes('yes') && handles.includes('no'));
          if (!hasTrueFalse) {
            throw new BadRequestException(
              `Condition node '${node.id}' outgoing edges must have sourceHandle 'true'/'false' (or 'yes'/'no'), found: ${handles.join(', ')}`,
            );
          }
          break;
        }

        case 'merge': {
          const inEdges = incomingEdges.get(node.id) || [];
          if (inEdges.length < 2) {
            throw new BadRequestException(
              `Merge node '${node.id}' must have at least 2 incoming edges, found ${inEdges.length}`,
            );
          }
          break;
        }

        case 'parallel': {
          const outEdges = outgoingEdges.get(node.id) || [];
          if (outEdges.length < 2) {
            throw new BadRequestException(
              `Parallel node '${node.id}' should have at least 2 outgoing edges, found ${outEdges.length}`,
            );
          }
          break;
        }

        case 'sub_agent': {
          const nodeData = node.data || node.config || {};
          const subAgentId = nodeData.agentId;
          if (!subAgentId) {
            throw new BadRequestException(
              `Sub-agent node '${node.id}' must have 'agentId' in config`,
            );
          }
          // Prevent direct self-recursion
          if (agentId && subAgentId === agentId) {
            throw new BadRequestException(
              `Sub-agent node '${node.id}' cannot reference the same agent (self-recursion)`,
            );
          }
          break;
        }

        case 'tool_call': {
          const toolData = node.data || node.config || {};
          if (!toolData.toolId) {
            throw new BadRequestException(
              `Tool call node '${node.id}' must have 'toolId' in config`,
            );
          }
          break;
        }

        case 'verify': {
          const verifyData = node.data || node.config || {};
          const checkers = verifyData.checkers;
          if (!Array.isArray(checkers) || checkers.length === 0) {
            throw new BadRequestException(
              `Verify node '${node.id}' must have a non-empty 'checkers' array in config`,
            );
          }
          // A checker says which model does the refuting, and there are two
          // ways to say it: pin a provider, or name a role and let the role
          // be filled at run time. Demanding a pinned provider made every
          // compiled strategy unsaveable — the compiler names roles and
          // never providers, on purpose — so a graph ejected from `cascade`
          // or `explore_extract_patch` could not be saved or activated at
          // all without pinning a provider and throwing away the
          // portability eject exists to preserve.
          checkers.forEach((checker: any, i: number) => {
            if (!checker || (!checker.providerId && !checker.roleKey)) {
              throw new BadRequestException(
                `Verify node '${node.id}' checker #${i + 1} must have a 'providerId' or a 'roleKey'`,
              );
            }
          });
          const policy = verifyData.policy;
          if (
            policy &&
            !['all_pass', 'majority', 'any_fail_blocks'].includes(policy)
          ) {
            throw new BadRequestException(
              `Verify node '${node.id}' has invalid policy '${policy}' (expected all_pass | majority | any_fail_blocks)`,
            );
          }
          break;
        }
      }
    }

    // Check for cycles via topological sort
    this.checkForCycles(pipeline);

    // Check that at least one output node is reachable from the input node.
    // Without this, a disconnected output silently survives validation and
    // the engine completes "successfully" with no output captured.
    this.checkOutputReachable(pipeline, inputNodes[0].id, outputNodes);

    // Check that no two output nodes can both run in the same execution.
    this.checkOutputsCannotCollide(pipeline, inputNodes[0].id, outputNodes);
  }

  /**
   * Two output nodes that can both run in one execution make the run's answer
   * depend on node order: the engine assigns `finalOutput` as it walks a
   * layer's results, so the last one written wins -- and "last" is wherever
   * the nodes happen to sit inside the persisted pipeline JSON.
   *
   * Two output nodes on opposite branches of a condition are not that: the
   * engine skips the untaken branch, so exactly one of them ever runs. So this
   * refuses only the pairs that no condition keeps apart, rather than banning
   * a second output node outright.
   *
   * Runs after `checkForCycles`, so the graph is known to be acyclic.
   */
  checkOutputsCannotCollide(
    pipeline: AgentPipeline,
    inputNodeId: string,
    outputNodes: AgentPipelineNode[],
  ): void {
    if (outputNodes.length < 2) return;

    const typeById = new Map(pipeline.nodes.map(n => [n.id, n.type]));
    const outgoing = new Map<string, AgentPipelineEdge[]>();
    for (const edge of pipeline.edges) {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source)!.push(edge);
    }

    /**
     * Which branch of a condition an edge sits on, or null when the engine
     * would never skip it. The handles the engine recognises are the only
     * ones that make two outputs exclusive.
     */
    const branchOf = (edge: AgentPipelineEdge): string | null => {
      const handle = edge.sourceHandle || (edge as any).label || '';
      if (handle === 'true' || handle === 'yes') return 'true';
      if (handle === 'false' || handle === 'no') return 'false';
      return null;
    };

    // For each output node, the condition decisions under which it is reached.
    const decisionsFor = new Map<string, Array<Map<string, string>>>();
    const seen = new Set<string>();
    let steps = 0;
    const MAX_STEPS = 5000;

    const walk = (nodeId: string, decisions: Map<string, string>): void => {
      if (++steps > MAX_STEPS) return;

      const key = `${nodeId}|${[...decisions.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}`;
      if (seen.has(key)) return;
      seen.add(key);

      if (typeById.get(nodeId) === 'output') {
        const paths = decisionsFor.get(nodeId) || [];
        paths.push(new Map(decisions));
        decisionsFor.set(nodeId, paths);
        return;
      }

      const isCondition = typeById.get(nodeId) === 'condition';
      for (const edge of outgoing.get(nodeId) || []) {
        const branch = isCondition ? branchOf(edge) : null;
        if (branch === null) {
          walk(edge.target, decisions);
          continue;
        }
        const next = new Map(decisions);
        next.set(nodeId, branch);
        walk(edge.target, next);
      }
    };

    walk(inputNodeId, new Map());

    /** Two decision sets can hold at once unless they disagree about a condition. */
    const canHoldTogether = (a: Map<string, string>, b: Map<string, string>): boolean => {
      for (const [condition, branch] of a) {
        const other = b.get(condition);
        if (other !== undefined && other !== branch) return false;
      }
      return true;
    };

    for (let i = 0; i < outputNodes.length; i++) {
      for (let j = i + 1; j < outputNodes.length; j++) {
        const left = decisionsFor.get(outputNodes[i].id) || [];
        const right = decisionsFor.get(outputNodes[j].id) || [];
        for (const a of left) {
          for (const b of right) {
            if (!canHoldTogether(a, b)) continue;
            throw new BadRequestException(
              `Output nodes '${outputNodes[i].id}' and '${outputNodes[j].id}' can both run in ` +
                'the same execution, so which one becomes the run\'s answer depends on the ' +
                'order the nodes happen to be stored in. Put them on opposite branches of a ' +
                'condition, or merge them into a single output node.',
            );
          }
        }
      }
    }
  }

  checkOutputReachable(
    pipeline: AgentPipeline,
    inputNodeId: string,
    outputNodes: AgentPipelineNode[],
  ): void {
    const adjacency = new Map<string, string[]>();
    for (const node of pipeline.nodes) adjacency.set(node.id, []);
    for (const edge of pipeline.edges) {
      adjacency.get(edge.source)?.push(edge.target);
    }

    const visited = new Set<string>();
    const stack = [inputNodeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const neighbor of adjacency.get(id) || []) {
        stack.push(neighbor);
      }
    }

    const reachableOutput = outputNodes.some(o => visited.has(o.id));
    if (!reachableOutput) {
      // Naming them: the old message said only 'check your edges', on a
      // canvas that draws no warning markers, so there was nothing to
      // check against.
      throw new BadRequestException(
        `Pipeline output node(s) ${outputNodes.map(o => `'${o.id}'`).join(', ')} are not reachable ` +
          `from the input node '${inputNodeId}'. Connect them with an edge.`,
      );
    }

    // An unconnected node is not inert. computeLayers seeds layer 0 with
    // every node of in-degree 0, so a dangling llm_call runs FIRST, before
    // anything else, and is billed -- while contributing nothing, because
    // no edge carries its output anywhere. That is a graph nobody meant to
    // draw, and the only evidence of it was the invoice.
    //
    // Refusal rather than a warning: it matches what the docs already
    // promise, and none of the built-in templates has an orphan node.
    const unreachable = pipeline.nodes.filter(n => !visited.has(n.id));
    if (unreachable.length) {
      throw new BadRequestException(
        `Node(s) ${unreachable.map(n => `'${n.id}'`).join(', ')} are not reachable from the input ` +
          `node '${inputNodeId}'. Connect them with an edge, or delete them — an unconnected node ` +
          `still runs, in the first layer, before anything else.`,
      );
    }
  }

  checkForCycles(pipeline: AgentPipeline): void {
    const adjacencyList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const node of pipeline.nodes) {
      adjacencyList.set(node.id, []);
      inDegree.set(node.id, 0);
    }

    for (const edge of pipeline.edges) {
      const neighbors = adjacencyList.get(edge.source) || [];
      neighbors.push(edge.target);
      adjacencyList.set(edge.source, neighbors);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    const queue: string[] = [];
    for (const node of pipeline.nodes) {
      if ((inDegree.get(node.id) || 0) === 0) {
        queue.push(node.id);
      }
    }

    // Tracked by id, not just counted: the nodes the sort never dequeues
    // are exactly the ones in the cycle, so the message can name them
    // instead of leaving someone to find a loop by eye on a canvas with no
    // warning markers.
    const sorted = new Set<string>();
    let visited = 0;
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      sorted.add(nodeId);
      visited++;
      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (visited !== pipeline.nodes.length) {
      const inCycle = pipeline.nodes.filter(n => !sorted.has(n.id)).map(n => `'${n.id}'`);
      throw new BadRequestException(
        `Pipeline contains a cycle through node(s) ${inCycle.join(', ')}. A pipeline runs ` +
          `each node once, in dependency order, so it cannot contain a loop back to an ` +
          `earlier node — remove one of the edges between them.`,
      );
    }
  }
}
