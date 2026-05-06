import { Agent } from '../../entities/agent.entity';

/**
 * Cost estimation heuristics extracted from AgentsService.
 * Pure functions of agent.pipeline — no DI, no DB.
 */

const LLM_MERGE_STRATEGIES = new Set(['best_of_n', 'consensus']);

export interface EstimatedCost {
  estimatedLlmCalls: number;
  estimatedToolCalls: number;
  hasParallelExecution: boolean;
  estimatedCostRange: { low: number; high: number };
  nodeCount: number;
  edgeCount: number;
}

export function estimateAgentCost(agent: Agent): EstimatedCost {
  const llmNodes = agent.pipeline.nodes.filter((n: any) => {
    if (n.type === 'llm_call') return true;
    if (n.type === 'merge') {
      const strategy = n.data?.strategy || n.config?.strategy;
      return LLM_MERGE_STRATEGIES.has(strategy);
    }
    return false;
  });
  const toolCallNodes = agent.pipeline.nodes.filter((n: any) => n.type === 'tool_call');
  const parallelNodes = agent.pipeline.nodes.filter((n: any) => n.type === 'parallel');

  let totalLow = 0;
  let totalHigh = 0;
  for (const node of llmNodes) {
    const model = ((node.data?.model as string) || '').toLowerCase();
    const providerType = ((node.data?.providerType as string) || '').toLowerCase();
    const { low, high } = estimateNodeCost(model, providerType);
    totalLow += low;
    totalHigh += high;
  }

  const toolCost = toolCallNodes.length * 0.1;
  totalLow += toolCost;
  totalHigh += toolCost;

  if (llmNodes.length === 0 && toolCallNodes.length === 0) {
    totalLow = 0;
    totalHigh = 0;
  }

  return {
    estimatedLlmCalls: llmNodes.length,
    estimatedToolCalls: toolCallNodes.length,
    hasParallelExecution: parallelNodes.length > 0,
    estimatedCostRange: {
      low: Math.round(totalLow * 10) / 10,
      high: Math.round(totalHigh * 10) / 10,
    },
    nodeCount: agent.pipeline.nodes.length,
    edgeCount: agent.pipeline.edges.length,
  };
}

/** Low/high cost estimate in cents for a single LLM call. */
function estimateNodeCost(model: string, providerType: string): { low: number; high: number } {
  if (model.includes('gpt-3.5') || model.includes('gpt-4o-mini') || model.includes('mini')) {
    return { low: 0.2, high: 1 };
  }
  if (model.includes('gpt-4o')) return { low: 1, high: 4 };
  if (model.includes('gpt-4')) return { low: 3, high: 8 };
  if (model.includes('opus')) return { low: 5, high: 15 };
  if (model.includes('sonnet')) return { low: 1, high: 4 };
  if (model.includes('haiku')) return { low: 0.2, high: 1 };
  if (model.includes('claude')) return { low: 2, high: 4 };
  if (providerType === 'anthropic') return { low: 2, high: 4 };
  if (providerType === 'openai') return { low: 1, high: 5 };
  return { low: 1, high: 5 };
}
