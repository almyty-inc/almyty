import { AgentPipeline, AgentPipelineEdge, AgentPipelineNode } from '../../../entities/agent.entity';
import { Strategy, StrategyStep } from '../../../entities/strategy.entity';

/**
 * Turn a strategy plus its role bindings into the pipeline the engine
 * already runs.
 *
 * The engine does not change shape for strategies. If you find yourself
 * editing the executor to make a strategy work, stop and change the
 * compiler instead: the whole value of this layer is that a strategy is a
 * description that reduces to nodes and edges that already execute.
 *
 * That also gives eject-to-graph for free. A strategy compiled and then
 * saved as an ordinary pipeline is the same graph the compiler would have
 * produced anyway, so ejecting cannot behave differently from running it.
 *
 * See docs/design/layers.md, L5.
 */

export class StrategyCompileError extends Error {
  readonly code = 'STRATEGY_COMPILE_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'StrategyCompileError';
  }
}

/** Which role key fills each slot the shape names. */
export type RoleBindings = Record<string, string>;

const NODE_TYPE: Record<StrategyStep['kind'], string> = {
  call: 'llm_call',
  extract_context: 'extract_context',
  verify: 'verify',
  merge: 'merge',
  parallel: 'parallel',
};

/**
 * Compile to a pipeline.
 *
 * `bindings` maps a slot named by the strategy to a role key on the
 * agent. The compiled node carries `roleKey`, never a model: L4 fills the
 * role at run time, so the graph stays as model-agnostic as the strategy
 * that produced it.
 */
export function compileStrategy(
  strategy: Pick<Strategy, 'key' | 'roleSlots' | 'shape'>,
  bindings: RoleBindings,
): AgentPipeline {
  const shape = strategy.shape;
  if (!shape?.steps?.length) throw new StrategyCompileError(`Strategy "${strategy.key}" has no steps`);

  const byId = new Map(shape.steps.map((s) => [s.id, s] as const));
  if (!byId.has(shape.entry)) {
    throw new StrategyCompileError(`Strategy "${strategy.key}" names entry "${shape.entry}", which is not one of its steps`);
  }

  const missing = (strategy.roleSlots ?? []).filter((slot) => !bindings[slot]);
  if (missing.length) {
    throw new StrategyCompileError(
      `Strategy "${strategy.key}" needs role slots that are not bound: ${missing.join(', ')}. ` +
        'Bind each slot to a role on this agent, or pick a strategy that needs fewer.',
    );
  }

  const nodes: AgentPipelineNode[] = [];
  const edges: AgentPipelineEdge[] = [];

  // An input node so the compiled graph is runnable on its own rather
  // than only as a fragment.
  nodes.push({ id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 } });

  shape.steps.forEach((step, i) => {
    const slotRole = step.roleSlot ? bindings[step.roleSlot] : undefined;
    if (step.roleSlot && !slotRole) {
      throw new StrategyCompileError(`Step "${step.id}" uses slot "${step.roleSlot}", which is not bound`);
    }
    nodes.push({
      id: step.id,
      type: NODE_TYPE[step.kind],
      label: step.roleSlot ? `${step.kind}: ${step.roleSlot}` : step.kind,
      position: { x: 220 * (i + 1), y: 0 },
      data: {
        // The compiled node names a ROLE, never a model. This is the line
        // that keeps a compiled graph as portable as the strategy was.
        ...(slotRole ? { roleKey: slotRole } : {}),
        ...(step.params ?? {}),
        strategyKey: strategy.key,
        strategyStep: step.id,
      },
    });
  });

  edges.push({ id: `e-input-${shape.entry}`, source: 'input', target: shape.entry });
  for (const step of shape.steps) {
    for (const next of step.next ?? []) {
      if (!byId.has(next)) {
        throw new StrategyCompileError(`Step "${step.id}" points at "${next}", which is not one of the strategy's steps`);
      }
      edges.push({ id: `e-${step.id}-${next}`, source: step.id, target: next });
    }
  }

  // Anything with no outgoing edge is a leaf, and every leaf feeds output.
  const hasNext = new Set(shape.steps.filter((s) => (s.next ?? []).length > 0).map((s) => s.id));
  nodes.push({ id: 'output', type: 'output', label: 'Output', position: { x: 220 * (shape.steps.length + 1), y: 0 } });
  for (const step of shape.steps) {
    if (!hasNext.has(step.id)) edges.push({ id: `e-${step.id}-output`, source: step.id, target: 'output' });
  }

  return { nodes, edges };
}

/**
 * What a strategy needs and roughly what it costs, for the picker.
 *
 * The bands are deliberately coarse. A precise number would be a lie: the
 * cost depends on which models fill the slots, and this layer does not
 * know that.
 */
export function describeStrategy(strategy: Pick<Strategy, 'key' | 'displayName' | 'roleSlots' | 'shape'>): {
  key: string;
  displayName: string;
  roleSlots: string[];
  steps: number;
  costBand: 'low' | 'medium' | 'high';
  latencyBand: 'low' | 'medium' | 'high';
} {
  const steps = strategy.shape?.steps ?? [];
  const calls = steps.filter((s) => s.kind === 'call' || s.kind === 'extract_context').length;
  const fanOut = steps
    .filter((s) => s.kind === 'parallel')
    .reduce((n, s) => n * (typeof s.params?.n === 'number' ? (s.params.n as number) : 1), 1);
  const weight = calls * Math.max(fanOut, 1);
  const band = (w: number): 'low' | 'medium' | 'high' => (w <= 1 ? 'low' : w <= 4 ? 'medium' : 'high');
  return {
    key: strategy.key,
    displayName: strategy.displayName,
    roleSlots: strategy.roleSlots ?? [],
    steps: steps.length,
    costBand: band(weight),
    // Work that fans out runs together, so latency tracks depth rather
    // than total calls.
    latencyBand: band(steps.length <= 2 ? 1 : steps.length <= 4 ? 3 : 5),
  };
}
