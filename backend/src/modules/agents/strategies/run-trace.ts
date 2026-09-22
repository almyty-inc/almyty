import { AgentExecution } from '../../../entities/agent-execution.entity';
import { ourHop, providerHop, summariseTrace, type RouteHop } from './route-trace';

/**
 * A run's trace, read from what the run already recorded.
 *
 * The hop model existed with nothing producing hops, so no run could show
 * where its request went. It needs no new collection either: a node result
 * already carries which model answered, what was tried before it, what
 * the policy rejected, and the timings. This assembles that.
 *
 * The honesty rules of the hop model are the reason to go through it
 * rather than shaping JSON here: a provider-side hop is opaque rather
 * than zero-cost, and a served model that differs from the requested one
 * is flagged instead of smoothed.
 */
export interface RunTrace {
  executionId: string;
  strategyKey?: string;
  strategyChosenBy?: string;
  strategyFallbackReason?: string;
  steps: Array<{
    nodeId: string;
    type?: string;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    error?: string;
    hops: RouteHop[];
  }>;
  summary: ReturnType<typeof summariseTrace>;
}

export function traceFor(execution: Pick<AgentExecution, 'id' | 'nodeResults' | 'metadata'>): RunTrace {
  const steps: RunTrace['steps'] = [];
  const allHops: RouteHop[] = [];

  for (const [nodeId, raw] of Object.entries(execution.nodeResults ?? {})) {
    const result = raw as any;
    const hops: RouteHop[] = [];
    const routing = result?.routing;

    if (routing?.modelId) {
      // What our routing decided, and what it passed over. Cost is ours
      // to know here, so it is given rather than left opaque.
      hops.push(
        ourHop({
          layer: 'routing',
          decidedBy: routing.rationale ? 'routing policy' : 'pinned model',
          chosen: routing.vendorModelId ?? routing.modelId,
          alternatives: [
            ...((routing.tried ?? []) as Array<{ modelId: string }>).map((t) => t.modelId),
            ...((routing.rejected ?? []) as Array<{ modelId: string }>).map((r) => r.modelId),
          ],
          reason: routing.rationale ?? 'chosen directly',
          latencyMs: result.executionTime,
          costEstimateCents: typeof result.cost === 'number' ? result.cost * 100 : undefined,
        }),
      );

      // The provider's own hop. What it did inside is not ours to price,
      // and an invented number would be worse than an admitted gap.
      hops.push(
        providerHop({
          layer: 'provider',
          decidedBy: routing.providerId ?? 'provider',
          chosen: routing.vendorModelId ?? routing.modelId,
          reason: 'served the call',
          requestedModel: routing.vendorModelId,
          servedModel: routing.servedModel ?? routing.vendorModelId,
        }),
      );
    }

    // A node that failed every candidate has no attribution, so its hops
    // are the attempts themselves — otherwise the trace goes quiet
    // exactly where someone is looking.
    for (const tried of (result?.triedModels ?? []) as Array<{ modelId: string; reason?: string }>) {
      hops.push(
        ourHop({
          layer: 'routing',
          decidedBy: 'routing policy',
          chosen: tried.modelId,
          reason: tried.reason ?? 'failed',
          costEstimateCents: undefined,
        }),
      );
    }

    steps.push({
      nodeId,
      type: result?.node?.type,
      startedAt: result?.startedAt,
      completedAt: result?.completedAt,
      durationMs: result?.executionTime,
      ...(result?.error ? { error: String(result.error) } : {}),
      hops,
    });
    allHops.push(...hops);
  }

  // Ordered by when they ran, so the timeline reads as the run happened
  // rather than as however the object was keyed.
  steps.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  const metadata = (execution.metadata ?? {}) as Record<string, any>;
  return {
    executionId: execution.id,
    ...(metadata.strategyKey ? { strategyKey: metadata.strategyKey } : {}),
    ...(metadata.strategyChosenBy ? { strategyChosenBy: metadata.strategyChosenBy } : {}),
    ...(metadata.strategyFallbackReason ? { strategyFallbackReason: metadata.strategyFallbackReason } : {}),
    steps,
    summary: summariseTrace(allHops),
  };
}
