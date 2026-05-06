import { BadRequestException } from '@nestjs/common';

import {
  AgentPipeline,
  AgentPipelineEdge,
  AgentPipelineNode,
} from '../../entities/agent.entity';

/**
 * Pure graph-shape primitives extracted from AgentExecutionEngine:
 * adjacency lists, layered topo sort, branch-pruning. No DI, no
 * mutable state — every function is a function of its arguments.
 */

export interface AgentExecutionGraph {
  adjacencyList: Map<string, string[]>;
  inDegree: Map<string, number>;
  reverseAdjacencyList: Map<string, string[]>;
}

/** Build adjacency list, in-degree map, and reverse adjacency list from pipeline edges. */
export function buildGraph(pipeline: AgentPipeline): AgentExecutionGraph {
  const adjacencyList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const reverseAdjacencyList = new Map<string, string[]>();

  for (const node of pipeline.nodes) {
    adjacencyList.set(node.id, []);
    reverseAdjacencyList.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of pipeline.edges) {
    const neighbors = adjacencyList.get(edge.source) || [];
    neighbors.push(edge.target);
    adjacencyList.set(edge.source, neighbors);

    const reverseNeighbors = reverseAdjacencyList.get(edge.target) || [];
    reverseNeighbors.push(edge.source);
    reverseAdjacencyList.set(edge.target, reverseNeighbors);

    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }

  return { adjacencyList, inDegree, reverseAdjacencyList };
}

/**
 * Compute execution layers using Kahn's algorithm with level tracking.
 * Nodes in the same layer have all dependencies satisfied and can run
 * in parallel.
 */
export function computeLayers(
  nodes: AgentPipelineNode[],
  adjacencyList: Map<string, string[]>,
  inDegree: Map<string, number>,
): string[][] {
  const layers: string[][] = [];
  const degrees = new Map(inDegree);

  let currentLayer: string[] = [];
  for (const node of nodes) {
    if ((degrees.get(node.id) || 0) === 0) {
      currentLayer.push(node.id);
    }
  }

  let totalProcessed = 0;

  while (currentLayer.length > 0) {
    layers.push([...currentLayer]);
    totalProcessed += currentLayer.length;

    const nextLayer: string[] = [];

    for (const nodeId of currentLayer) {
      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        const newDegree = (degrees.get(neighbor) || 0) - 1;
        degrees.set(neighbor, newDegree);
        if (newDegree === 0) {
          nextLayer.push(neighbor);
        }
      }
    }

    currentLayer = nextLayer;
  }

  if (totalProcessed !== nodes.length) {
    throw new BadRequestException('Pipeline contains a cycle — topological sort failed');
  }

  return layers;
}

/**
 * Recursively mark all downstream nodes of a given node as skipped.
 * Used when a condition branch is not taken. Stops at merge nodes
 * that have other non-skipped incoming edges.
 */
export function markBranchAsSkipped(
  nodeId: string,
  adjacencyList: Map<string, string[]>,
  skippedNodes: Set<string>,
  edges: AgentPipelineEdge[],
): void {
  if (skippedNodes.has(nodeId)) return;

  const incomingEdges = edges.filter(e => e.target === nodeId);
  const hasLiveIncoming = incomingEdges.some(e => !skippedNodes.has(e.source));

  if (hasLiveIncoming && incomingEdges.length > 1) {
    return;
  }

  skippedNodes.add(nodeId);

  const neighbors = adjacencyList.get(nodeId) || [];
  for (const neighbor of neighbors) {
    markBranchAsSkipped(neighbor, adjacencyList, skippedNodes, edges);
  }
}
