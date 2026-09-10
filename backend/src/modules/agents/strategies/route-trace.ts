/**
 * Where a request actually went.
 *
 * Cross-cutting. Every step records the hops it took, including hops
 * below us: an aggregator routes again after we hand it a request, so a
 * trace that stops at our own decision is not a trace of what happened.
 *
 * Two rules, both about not lying:
 *
 *   - **Never report a cost we cannot know.** A provider-side hop is
 *     marked opaque rather than given a number, because an invented
 *     number is worse than an admitted gap.
 *   - **Divergence is flagged, not smoothed.** Where a provider reports
 *     what it actually served and that differs from what we asked for,
 *     the trace says so. Silent substitution is the failure this exists
 *     to catch.
 *
 * See docs/design/layers.md, cross-cutting.
 */

export type TraceLayer = 'routing' | 'roles' | 'strategy' | 'orchestrator' | 'provider' | 'gateway';

export interface RouteHop {
  layer: TraceLayer;
  /** What made the decision: a policy, a role key, an aggregator's name. */
  decidedBy: string;
  chosen: string;
  alternatives?: string[];
  reason: string;
  latencyMs?: number;
  /**
   * Cents, or null when the hop's cost is not ours to know. Null is a
   * real answer and is rendered as "opaque", never as zero.
   */
  costEstimateCents?: number | null;
  /** True when costEstimateCents is null because the hop is below us. */
  opaqueCost?: boolean;
  /** What we asked this hop for, when it can substitute. */
  requestedModel?: string;
  /** What it says it served. */
  servedModel?: string;
  /** Set when served differs from requested. */
  divergent?: boolean;
  /**
   * Capabilities lost by taking this path rather than the preferred one.
   * A downgrade from a native protocol to a compatibility shim is allowed;
   * doing it silently is not.
   */
  capabilitiesDropped?: string[];
}

/** Record a decision this platform made. Cost is knowable, so it is given. */
export function ourHop(hop: Omit<RouteHop, 'opaqueCost'>): RouteHop {
  return { ...hop, opaqueCost: false };
}

/**
 * Record a hop below us: an aggregator, a gateway, a provider-side
 * router. The decision continues there and its cost is not ours to know.
 */
export function providerHop(hop: Omit<RouteHop, 'opaqueCost' | 'costEstimateCents' | 'divergent'>): RouteHop {
  const divergent = Boolean(hop.requestedModel && hop.servedModel && hop.requestedModel !== hop.servedModel);
  return {
    ...hop,
    costEstimateCents: null,
    opaqueCost: true,
    ...(divergent ? { divergent: true } : {}),
  };
}

/** Total of the hops we can price, and how many we cannot. */
export function summariseTrace(hops: RouteHop[]): {
  knownCostCents: number;
  opaqueHops: number;
  divergences: RouteHop[];
  capabilitiesDropped: string[];
} {
  let knownCostCents = 0;
  let opaqueHops = 0;
  const dropped = new Set<string>();
  for (const hop of hops) {
    if (hop.costEstimateCents == null) opaqueHops++;
    else knownCostCents += hop.costEstimateCents;
    for (const c of hop.capabilitiesDropped ?? []) dropped.add(c);
  }
  return {
    knownCostCents,
    opaqueHops,
    divergences: hops.filter((h) => h.divergent),
    capabilitiesDropped: [...dropped],
  };
}
