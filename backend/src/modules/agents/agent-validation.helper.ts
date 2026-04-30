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
      throw new BadRequestException('Pipeline node IDs must be unique');
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
      }
    }

    // Check for cycles via topological sort
    this.checkForCycles(pipeline);

    // Check that at least one output node is reachable from the input node.
    // Without this, a disconnected output silently survives validation and
    // the engine completes "successfully" with no output captured.
    this.checkOutputReachable(pipeline, inputNodes[0].id, outputNodes);
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
      throw new BadRequestException(
        'Pipeline output node(s) are not reachable from the input node — check your edges',
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

    let visited = 0;
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
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
      throw new BadRequestException('Pipeline contains a cycle');
    }
  }
}
