/**
 * Rendering for @almyty/agents.
 *
 * Pure functions, no I/O, so the shape of what a user sees is testable
 * without a backend. The interesting part is attribution: a routed call
 * stamps `routing` on the step / node result, and the CLI used to throw
 * all of it away — so `agents run` could not answer "which model
 * answered this, and what did it cost", which is the first question
 * anyone asks about a multi-model agent.
 */

export interface RoutingAttribution {
  modelId?: string;
  modelVersionId?: string | null;
  vendorModelId?: string;
  providerId?: string | null;
  rationale?: string;
  attempt?: number;
  tried?: Array<{ modelId: string; reason: string }>;
  rejected?: Array<{ modelId: string; reason: string }>;
}

export interface RunStep {
  type?: string;
  input?: any;
  output?: any;
  cost?: number;
  tokens?: { input?: number; output?: number };
  duration?: number;
  timestamp?: string;
  error?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  mode?: string;
  status?: string;
  pipeline?: { nodes?: Array<{ id: string; type: string; label?: string }> };
  modelConfig?: Record<string, unknown>;
  tools?: Array<{ id: string; name: string }>;
}

/** Terminal statuses that mean the run did what was asked. */
export const RUN_SUCCEEDED = new Set(['completed', 'succeeded']);

/** A status that will never change on its own. */
export const RUN_TERMINAL = new Set([
  'completed',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

export function runSucceeded(status: string | undefined): boolean {
  return status !== undefined && RUN_SUCCEEDED.has(status);
}

/** `$0.0042`, or `—` when nothing was recorded. A zero cost prints as $0. */
export function formatCost(cost: unknown): string {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return '—';
  if (cost === 0) return '$0';
  return `$${cost < 0.01 ? cost.toFixed(6) : cost.toFixed(4)}`;
}

export function formatTokens(tokens: unknown): string {
  if (typeof tokens === 'number' && Number.isFinite(tokens)) {
    return tokens.toLocaleString('en-US');
  }
  if (tokens && typeof tokens === 'object') {
    const t = tokens as { input?: number; output?: number };
    const inTok = t.input ?? 0;
    const outTok = t.output ?? 0;
    if (inTok === 0 && outTok === 0) return '—';
    return `${inTok.toLocaleString('en-US')} in / ${outTok.toLocaleString('en-US')} out`;
  }
  return '—';
}

export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

/** Whichever name a routed call gives for the model that answered. */
export function modelOf(routing: RoutingAttribution | undefined): string | null {
  if (!routing) return null;
  return routing.vendorModelId || routing.modelId || null;
}

/**
 * One line naming the model that answered and why it was picked.
 * `null` when the call was not routed (a pinned provider leaves no
 * attribution, and inventing one would be worse than saying nothing).
 */
export function formatRouting(routing: RoutingAttribution | undefined): string | null {
  const model = modelOf(routing);
  if (!model || !routing) return null;
  const parts = [model];
  if (typeof routing.attempt === 'number' && routing.attempt > 1) {
    parts.push(`attempt ${routing.attempt}`);
  }
  if (routing.rationale) parts.push(routing.rationale);
  const skipped = (routing.tried ?? []).length + (routing.rejected ?? []).length;
  if (skipped > 0) parts.push(`${skipped} candidate(s) passed over`);
  return parts.join(' · ');
}

/** The routing attribution a step carries, wherever it was stamped. */
export function routingOfStep(step: RunStep | undefined): RoutingAttribution | undefined {
  const routing = step?.output?.routing;
  return routing && typeof routing === 'object' ? (routing as RoutingAttribution) : undefined;
}

/**
 * One line per step, as `run --watch` streams them.
 * Returns null for a step with nothing worth showing.
 */
export function formatStep(step: RunStep | undefined, index?: number): string | null {
  if (!step) return null;
  const n = index === undefined ? '' : `${index + 1}. `;
  const meta: string[] = [];
  const routing = formatRouting(routingOfStep(step));
  if (routing) meta.push(routing);
  if (typeof step.cost === 'number' && step.cost > 0) meta.push(formatCost(step.cost));
  const tokens = formatTokens(step.tokens);
  if (tokens !== '—') meta.push(tokens);
  if (typeof step.duration === 'number') meta.push(formatDuration(step.duration));
  const suffix = meta.length ? `  [${meta.join(' · ')}]` : '';

  switch (step.type) {
    case 'llm_call': {
      const status = step.output?.status;
      if (typeof step.output?.content === 'string' && step.output.content.length > 0) {
        return `  ${n}${step.output.content}${suffix}`;
      }
      if (Array.isArray(step.output?.toolCalls) && step.output.toolCalls.length > 0) {
        const names = step.output.toolCalls
          .map((tc: any) => tc?.name ?? '?')
          .join(', ');
        return `  ${n}llm_call → tools: ${names}${suffix}`;
      }
      if (status === 'waiting_input') {
        return `  ${n}waiting for input: ${step.output?.question ?? '(no question given)'}${suffix}`;
      }
      if (status === 'sleeping') {
        return `  ${n}sleeping: ${step.output?.reason ?? '(no reason given)'}${suffix}`;
      }
      return `  ${n}llm_call${suffix}`;
    }
    case 'tool_call':
      return `  ${n}tool_call → ${step.input?.tool ?? step.input?.name ?? '?'}${suffix}`;
    case 'sub_agent_call':
      return `  ${n}sub_agent_call → ${step.input?.agentId ?? '?'}${suffix}`;
    case 'error':
      return `  ${n}error: ${step.error ?? 'unknown'}${suffix}`;
    default:
      return step.type ? `  ${n}${step.type}${suffix}` : null;
  }
}

/**
 * The closing line of a run: status, what it cost, and which models
 * answered. Someone reading a CI log should not have to open the UI to
 * learn any of the three.
 */
export function formatRunSummary(run: {
  status?: string;
  totalCost?: number;
  totalTokens?: number;
  executionTime?: number;
  steps?: RunStep[];
}): string {
  const models = new Set<string>();
  for (const step of run.steps ?? []) {
    const model = modelOf(routingOfStep(step));
    if (model) models.add(model);
  }
  const bits = [`Run ${run.status ?? 'unknown'}`];
  if (models.size > 0) bits.push(`answered by ${[...models].join(', ')}`);
  bits.push(formatCost(run.totalCost));
  const tokens = formatTokens(run.totalTokens);
  if (tokens !== '—') bits.push(`${tokens} tokens`);
  if (typeof run.executionTime === 'number' && run.executionTime > 0) {
    bits.push(formatDuration(run.executionTime));
  }
  return bits.join(' · ');
}

/**
 * The same closing line for a workflow execution, whose attribution
 * lives per node rather than per step.
 */
export function formatExecutionSummary(execution: {
  status?: string;
  totalCost?: number;
  totalTokens?: number;
  executionTime?: number;
  nodeResults?: Record<string, any>;
}): string {
  const models = new Set<string>();
  let failed = 0;
  for (const result of Object.values(execution.nodeResults ?? {})) {
    const model = modelOf(result?.routing);
    if (model) models.add(model);
    if (result?.error) failed++;
  }
  const bits = [`Run ${execution.status ?? 'unknown'}`];
  if (models.size > 0) bits.push(`answered by ${[...models].join(', ')}`);
  if (failed > 0) bits.push(`${failed} node(s) failed`);
  bits.push(formatCost(execution.totalCost));
  const tokens = formatTokens(execution.totalTokens);
  if (tokens !== '—') bits.push(`${tokens} tokens`);
  if (typeof execution.executionTime === 'number' && execution.executionTime > 0) {
    bits.push(formatDuration(execution.executionTime));
  }
  return bits.join(' · ');
}

/**
 * Per-node detail for a workflow run: which node failed, what was tried,
 * and what answered. This is what you would otherwise open the UI for.
 */
export function formatNodeResults(nodeResults: Record<string, any> | undefined): string[] {
  const lines: string[] = [];
  // Skipped nodes never ran, so they carry no timestamp. Treating a
  // missing startedAt as 0 floated them to the top of the list, above
  // the nodes that actually executed.
  const entries = Object.entries(nodeResults ?? {}).sort(
    (a, b) => (a[1]?.startedAt ?? Infinity) - (b[1]?.startedAt ?? Infinity),
  );
  for (const [nodeId, result] of entries) {
    if (result?.skipped) {
      lines.push(`  ${nodeId}  skipped`);
      continue;
    }
    if (result?.error) {
      lines.push(`  ${nodeId}  FAILED  ${result.error}`);
      if (result.errorCode) {
        lines.push(`      code: ${result.errorCode}${result.errorModel ? ` model: ${result.errorModel}` : ''}`);
      }
      for (const tried of result.triedModels ?? []) {
        lines.push(`      tried ${tried.modelId}: ${tried.reason ?? 'failed'}`);
      }
      continue;
    }
    const meta: string[] = [];
    const routing = formatRouting(result?.routing);
    if (routing) meta.push(routing);
    if (typeof result?.cost === 'number') meta.push(formatCost(result.cost));
    if (result?.tokens) meta.push(`${formatTokens(result.tokens)} tokens`);
    if (typeof result?.executionTime === 'number') meta.push(formatDuration(result.executionTime));
    lines.push(`  ${nodeId}  ok${meta.length ? `  [${meta.join(' · ')}]` : ''}`);
  }
  return lines;
}

/** The full detail of one autonomous run, for `agents inspect`. */
export function formatRunDetail(run: {
  id?: string;
  agentId?: string;
  status?: string;
  mode?: string;
  conversationId?: string;
  createdAt?: string;
  updatedAt?: string;
  currentStep?: number;
  maxSteps?: number;
  totalCost?: number;
  totalTokens?: number;
  executionTime?: number;
  error?: string;
  output?: unknown;
  steps?: RunStep[];
  limits?: Record<string, unknown>;
}): string {
  const lines: string[] = [];
  lines.push(`Run ${run.id ?? '(no id)'}`);
  lines.push(`  status:    ${run.status ?? 'unknown'}`);
  if (run.mode) lines.push(`  mode:      ${run.mode}`);
  if (run.createdAt) lines.push(`  started:   ${run.createdAt}`);
  if (run.updatedAt) lines.push(`  updated:   ${run.updatedAt}`);
  if (run.conversationId) lines.push(`  conversation: ${run.conversationId}`);
  lines.push(`  steps:     ${run.steps?.length ?? run.currentStep ?? 0}${run.maxSteps ? ` of max ${run.maxSteps}` : ''}`);
  lines.push(`  cost:      ${formatCost(run.totalCost)}`);
  lines.push(`  tokens:    ${formatTokens(run.totalTokens)}`);
  lines.push(`  duration:  ${formatDuration(run.executionTime)}`);

  const models = new Set<string>();
  for (const step of run.steps ?? []) {
    const model = modelOf(routingOfStep(step));
    if (model) models.add(model);
  }
  if (models.size > 0) lines.push(`  models:    ${[...models].join(', ')}`);

  if (run.error) {
    lines.push('');
    lines.push(`  error:     ${run.error}`);
  }

  const steps = run.steps ?? [];
  if (steps.length > 0) {
    lines.push('');
    lines.push('Steps:');
    steps.forEach((step, i) => {
      const line = formatStep(step, i);
      if (line) lines.push(line);
    });
  }

  if (run.output != null) {
    lines.push('');
    lines.push('Output:');
    lines.push(
      typeof run.output === 'string'
        ? run.output
        : JSON.stringify(run.output, null, 2),
    );
  }
  return lines.join('\n');
}

/**
 * The hop-by-hop trace the backend assembles at
 * /agents/:id/executions/:executionId/trace. An opaque hop is printed
 * as opaque, never as zero — the backend is deliberate about that and
 * flattening it here would undo the point.
 */
export function formatTrace(trace: {
  executionId?: string;
  strategyKey?: string;
  strategyChosenBy?: string;
  strategyFallbackReason?: string;
  steps?: Array<{
    nodeId: string;
    type?: string;
    durationMs?: number;
    error?: string;
    hops?: Array<{
      layer?: string;
      decidedBy?: string;
      chosen?: string;
      reason?: string;
      alternatives?: string[];
      latencyMs?: number;
      costEstimateCents?: number | null;
      opaqueCost?: boolean;
      requestedModel?: string;
      servedModel?: string;
      divergent?: boolean;
      capabilitiesDropped?: string[];
    }>;
  }>;
  summary?: {
    knownCostCents?: number;
    opaqueHops?: number;
    divergences?: unknown[];
    capabilitiesDropped?: string[];
  };
}): string {
  const lines: string[] = [];
  lines.push(`Trace for execution ${trace.executionId ?? '(no id)'}`);
  if (trace.strategyKey) {
    lines.push(
      `  strategy: ${trace.strategyKey}${trace.strategyChosenBy ? ` (chosen by ${trace.strategyChosenBy})` : ''}`,
    );
  }
  if (trace.strategyFallbackReason) {
    lines.push(`  fell back because: ${trace.strategyFallbackReason}`);
  }

  for (const step of trace.steps ?? []) {
    lines.push('');
    const head = [step.nodeId];
    if (step.type) head.push(step.type);
    if (step.durationMs != null) head.push(formatDuration(step.durationMs));
    lines.push(head.join('  '));
    if (step.error) lines.push(`  error: ${step.error}`);
    if (!step.hops?.length) {
      lines.push('  (no hops recorded — the call was not routed)');
      continue;
    }
    for (const hop of step.hops) {
      const cost = hop.opaqueCost
        ? 'cost opaque'
        : hop.costEstimateCents != null
          ? `${hop.costEstimateCents.toFixed(4)}¢`
          : 'cost not recorded';
      const bits = [`${hop.layer ?? 'hop'}`, hop.chosen ?? '?', cost];
      if (hop.latencyMs != null) bits.push(formatDuration(hop.latencyMs));
      lines.push(`  ${bits.join('  ')}`);
      if (hop.decidedBy) lines.push(`      decided by: ${hop.decidedBy}`);
      if (hop.reason) lines.push(`      reason: ${hop.reason}`);
      if (hop.alternatives?.length) {
        lines.push(`      passed over: ${hop.alternatives.join(', ')}`);
      }
      if (hop.divergent) {
        lines.push(
          `      DIVERGENT: asked for ${hop.requestedModel ?? '?'}, served ${hop.servedModel ?? '?'}`,
        );
      }
      if (hop.capabilitiesDropped?.length) {
        lines.push(`      capabilities dropped: ${hop.capabilitiesDropped.join(', ')}`);
      }
    }
  }

  const summary = trace.summary;
  if (summary) {
    lines.push('');
    lines.push('Summary:');
    lines.push(`  known cost:   ${(summary.knownCostCents ?? 0).toFixed(4)}¢`);
    lines.push(`  opaque hops:  ${summary.opaqueHops ?? 0}`);
    lines.push(`  divergences:  ${summary.divergences?.length ?? 0}`);
    if (summary.capabilitiesDropped?.length) {
      lines.push(`  dropped:      ${summary.capabilitiesDropped.join(', ')}`);
    }
  }
  return lines.join('\n');
}

/** One agent per block, for `agents list`. */
export function formatAgentLine(agent: AgentSummary): string {
  const mode = agent.mode ? ` [${agent.mode}]` : '';
  const status = agent.status ? ` (${agent.status})` : '';
  const desc = agent.description ? `\n      ${agent.description}` : '';
  return `  ${agent.name}${mode}${status}${desc}`;
}

/** Everything `agents get` knows, so the next question is not "and then?". */
export function formatAgentDetail(agent: AgentSummary): string {
  const lines: string[] = [];
  lines.push(`  ${agent.name}`);
  lines.push(`  id:      ${agent.id}`);
  if (agent.slug) lines.push(`  slug:    ${agent.slug}`);
  if (agent.mode) lines.push(`  mode:    ${agent.mode}`);
  if (agent.status) lines.push(`  status:  ${agent.status}`);
  if (agent.description) lines.push(`  desc:    ${agent.description}`);

  const model = agent.modelConfig ?? {};
  const modelBits: string[] = [];
  if (typeof model.model === 'string') modelBits.push(model.model as string);
  if (typeof model.providerId === 'string') modelBits.push(`provider ${model.providerId}`);
  if (model.routing) modelBits.push('routed (policy on the agent)');
  if (typeof model.temperature === 'number') modelBits.push(`temp ${model.temperature}`);
  if (modelBits.length) lines.push(`  model:   ${modelBits.join(' · ')}`);

  const nodes = agent.pipeline?.nodes ?? [];
  if (nodes.length) {
    const byType = new Map<string, number>();
    for (const node of nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    const shape = [...byType.entries()].map(([t, n]) => `${n}x ${t}`).join(', ');
    lines.push(`  pipeline: ${nodes.length} node(s) — ${shape}`);
  }

  if (agent.tools?.length) {
    lines.push(`  tools:   ${agent.tools.map((t) => t.name).join(', ')}`);
  }

  // The single most common first failure: invoking a DRAFT agent.
  if (agent.status && agent.status.toLowerCase() !== 'active') {
    lines.push('');
    lines.push(`  This agent is ${agent.status} — activate it before running it.`);
  }
  return lines.join('\n');
}

/**
 * The message for trying to run a non-active agent.
 *
 * The API answers 400 with a JSON body, and the CLI printed the body:
 * `API error 400: {"success":false,"message":"Agent must be active to
 * invoke","error":"AGENT_NOT_ACTIVE"}`. The agent's status is already
 * in hand before the call, so say it plainly and skip the round trip.
 */
export function notActiveMessage(agent: { name: string; id: string; status?: string }): string {
  return [
    `Agent "${agent.name}" is ${agent.status ?? 'not active'} and cannot be run.`,
    `Activate it, then try again:`,
    `  in the app:  https://app.almyty.com/agents/${agent.id}`,
  ].join('\n');
}
