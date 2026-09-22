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

  // A `parallel` step with `n` means "run what comes next n times over".
  // That has to happen HERE, at compile time, by emitting n copies of each
  // immediate target: the engine's parallel node is a pass-through, so a
  // graph carrying `n` as node data and one downstream step runs that step
  // exactly once. best-of-n was best-of-one and explore-extract-patch read
  // a single rollout, both while `describe()` quoted a cost band computed
  // from the n that never happened.
  //
  // The rule is deliberately one step wide: the targets replicate, and
  // everything past them converges. That is what both fan-out shapes
  // want — three candidates into one judge, three rollouts into one
  // extraction — and it keeps "where does the fan-in happen" answerable
  // by reading the shape.
  const fanOutOf = new Map<string, number>();
  for (const step of shape.steps) {
    if (step.kind !== 'parallel') continue;
    const n = step.params?.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      if (n !== undefined) {
        throw new StrategyCompileError(
          `Step "${step.id}" has n=${JSON.stringify(n)}. A parallel step's n must be a whole number of branches, at least 1.`,
        );
      }
      continue;
    }
    if (n === 1) continue;
    for (const target of step.next ?? []) {
      const t = byId.get(target);
      if (!t) continue; // reported by the edge pass below
      if (t.kind === 'parallel') {
        throw new StrategyCompileError(
          `Step "${step.id}" fans out to "${target}", which is itself a parallel step. ` +
            'Nested fan-out is not compiled; give the inner step its own n instead.',
        );
      }
      const otherParents = shape.steps.filter((s) => s.id !== step.id && (s.next ?? []).includes(target));
      if (otherParents.length) {
        throw new StrategyCompileError(
          `Step "${step.id}" fans out to "${target}", but "${target}" is also reached from ` +
            `${otherParents.map((s) => `"${s.id}"`).join(', ')}. A replicated step must have one parent, ` +
            'otherwise there is no telling which copy the other parent feeds.',
        );
      }
      fanOutOf.set(target, n);
    }
  }

  /** Every node id a step compiles to: one, or n when it is replicated. */
  const idsFor = (stepId: string): string[] => {
    const n = fanOutOf.get(stepId);
    return n === undefined ? [stepId] : Array.from({ length: n }, (_, k) => `${stepId}#${k + 1}`);
  };

  // A `verify` step's `next` is its FAILURE path, and that has to compile
  // to a branch rather than to an ordinary edge.
  //
  // Cascade is the shape that depends on it: draft cheaply, check, and
  // escalate to the expensive role ONLY when the check fails. Compiled as
  // a plain edge, `check -> escalate` ran every time, so the escalation
  // the strategy exists to avoid was the one thing it always paid for —
  // and `escalate` was the pipeline's only leaf, so its answer was the
  // result even when the draft had passed.
  //
  // The engine already knows how to skip a branch: a `condition` node
  // outputs `{__condition, result}` and the engine skips whatever hangs
  // off the untaken handle. So the compiler emits one, exactly as the
  // rule requires — the branch is a graph the engine already runs, not a
  // new thing the executor has to learn.
  const gateIdFor = (verifyNodeId: string): string => `${verifyNodeId}__gate`;
  const isGated = (step: StrategyStep): boolean => step.kind === 'verify' && (step.next ?? []).length > 0;

  shape.steps.forEach((step, i) => {
    const slotRole = step.roleSlot ? bindings[step.roleSlot] : undefined;
    if (step.roleSlot && !slotRole) {
      throw new StrategyCompileError(`Step "${step.id}" uses slot "${step.roleSlot}", which is not bound`);
    }
    const copies = idsFor(step.id);
    if (isGated(step) && copies.length > 1) {
      throw new StrategyCompileError(
        `Step "${step.id}" is a verify step with a failure path, and it is also replicated by a fan-out. ` +
          'A gated check compiles to one branch per check; fan out before the check or after it, not across it.',
      );
    }
    copies.forEach((id, branch) => {
      nodes.push({
        id,
        type: NODE_TYPE[step.kind],
        label:
          (step.roleSlot ? `${step.kind}: ${step.roleSlot}` : step.kind) +
          (copies.length > 1 ? ` (${branch + 1}/${copies.length})` : ''),
        position: { x: 220 * (i + 1), y: 160 * branch },
        data: {
          // The compiled node names a ROLE, never a model. This is the line
          // that keeps a compiled graph as portable as the strategy was.
          ...(slotRole ? { roleKey: slotRole } : {}),
          // A verify node runs a panel of checkers, and a checker needs a
          // model. The strategy names a slot, so the compiled checker names
          // the role bound to that slot — the same answer `llm_call` and a
          // judged `merge` give. Emitting the node without one left the two
          // shapes that verify (`cascade`, `explore_extract_patch`) throwing
          // "requires at least one checker" the moment a run reached the
          // check, and left the graph unsaveable besides.
          ...(step.kind === 'verify' && slotRole && step.params?.checkers === undefined
            ? { checkers: [{ name: step.roleSlot ?? 'verifier', roleKey: slotRole }] }
            : {}),
          ...(step.params ?? {}),
          strategyKey: strategy.key,
          strategyStep: step.id,
          ...(copies.length > 1 ? { strategyBranch: branch + 1 } : {}),
        },
      });
      if (isGated(step)) {
        nodes.push({
          id: gateIdFor(id),
          type: 'condition',
          label: 'check passed?',
          position: { x: 220 * (i + 1) + 130, y: 160 * branch + 120 },
          data: {
            // An unresolved verdict reads as "" and falls to the false
            // handle, so "we could not tell" escalates rather than
            // silently passing an unchecked draft.
            expression: `{{nodes.${id}.output.passed}} == true`,
            strategyKey: strategy.key,
            strategyStep: step.id,
            strategyGate: true,
          },
        });
      }
    });
  });

  // The output node has to exist before the edges that reach it: a gate's
  // pass path goes straight there.
  nodes.push({ id: 'output', type: 'output', label: 'Output', position: { x: 220 * (shape.steps.length + 1), y: 0 } });

  for (const entryId of idsFor(shape.entry)) {
    edges.push({ id: `e-input-${entryId}`, source: 'input', target: entryId });
  }
  for (const step of shape.steps) {
    for (const next of step.next ?? []) {
      if (!byId.has(next)) {
        throw new StrategyCompileError(`Step "${step.id}" points at "${next}", which is not one of the strategy's steps`);
      }
    }
    if (isGated(step)) {
      const failTargets = (step.next ?? []).flatMap((next) => idsFor(next));
      if (failTargets.length !== 1) {
        throw new StrategyCompileError(
          `Step "${step.id}" is a verify step with ${failTargets.length} failure targets. ` +
            'A check branches two ways — passed, or failed — so it needs exactly one step to escalate to.',
        );
      }
      for (const source of idsFor(step.id)) {
        const gate = gateIdFor(source);
        edges.push({ id: `e-${source}-${gate}`, source, target: gate });
        edges.push({
          id: `e-${gate}-false-${failTargets[0]}`,
          source: gate,
          target: failTargets[0],
          sourceHandle: 'false',
          label: 'check failed',
        });
        // The pass path skips the escalation entirely. That skip IS the
        // saving cascade is sold on.
        edges.push({ id: `e-${gate}-true-output`, source: gate, target: 'output', sourceHandle: 'true', label: 'check passed' });
      }
      continue;
    }
    for (const next of step.next ?? []) {
      for (const source of idsFor(step.id)) {
        for (const target of idsFor(next)) {
          edges.push({ id: `e-${source}-${target}`, source, target });
        }
      }
    }
  }

  // Anything with no outgoing edge is a leaf, and every leaf feeds output.
  const hasNext = new Set(shape.steps.filter((s) => (s.next ?? []).length > 0).map((s) => s.id));
  for (const step of shape.steps) {
    if (hasNext.has(step.id)) continue;
    for (const source of idsFor(step.id)) {
      edges.push({ id: `e-${source}-output`, source, target: 'output' });
    }
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
export function describeStrategy(strategy: Pick<Strategy, 'key' | 'displayName' | 'roleSlots' | 'shape'> & { experimental?: boolean }): {
  key: string;
  displayName: string;
  roleSlots: string[];
  steps: number;
  costBand: 'low' | 'medium' | 'high';
  latencyBand: 'low' | 'medium' | 'high';
  experimental: boolean;
} {
  const steps = strategy.shape?.steps ?? [];

  // How many copies of each step the compiler would emit. Same rule as
  // compileStrategy — a parallel step's n replicates its immediate
  // targets — so the band the picker shows is a band on the graph that
  // actually runs. It used to multiply every call by every n, which
  // overstated any shape with a step past the fan-in.
  const copies = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== 'parallel') continue;
    const n = step.params?.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 2) continue;
    for (const target of step.next ?? []) copies.set(target, n);
  }

  // Every step that spends a model call, counted once per copy. A merge
  // only calls when it has to judge.
  const spends = (kind: string, params?: Record<string, any>) =>
    kind === 'call' ||
    kind === 'extract_context' ||
    kind === 'verify' ||
    (kind === 'merge' && (params?.strategy === 'best_of_n' || params?.strategy === 'consensus'));

  const weight = steps.reduce(
    (total, step) => total + (spends(step.kind, step.params) ? (copies.get(step.id) ?? 1) : 0),
    0,
  );
  const band = (w: number): 'low' | 'medium' | 'high' => (w <= 1 ? 'low' : w <= 4 ? 'medium' : 'high');
  return {
    key: strategy.key,
    displayName: strategy.displayName,
    roleSlots: strategy.roleSlots ?? [],
    experimental: Boolean(strategy.experimental),
    steps: steps.length,
    costBand: band(weight),
    // Work that fans out runs together, so latency tracks depth rather
    // than total calls.
    latencyBand: band(steps.length <= 2 ? 1 : steps.length <= 4 ? 3 : 5),
  };
}
