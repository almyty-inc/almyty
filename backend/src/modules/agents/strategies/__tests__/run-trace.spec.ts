import { traceFor } from '../run-trace';

/**
 * The trace a run can actually show.
 *
 * The hop model was written with nothing producing hops, so no run could
 * say where its request went. What matters in the assembly is the two
 * honesty rules surviving it: a provider-side hop stays opaque rather
 * than becoming a zero, and a node where everything failed still produces
 * hops — otherwise the trace goes quiet exactly where someone is looking.
 */
const execution = (nodeResults: Record<string, any>, metadata: Record<string, any> = {}) =>
  ({ id: 'e1', nodeResults, metadata }) as any;

describe('a run trace', () => {
  it('shows the routing decision and what it passed over', () => {
    const trace = traceFor(
      execution({
        n1: {
          executionTime: 120,
          cost: 0.02,
          routing: {
            modelId: 'fast',
            vendorModelId: 'gpt-4o-mini',
            rationale: 'cheapest',
            tried: [{ modelId: 'cheap' }],
            rejected: [{ modelId: 'local' }],
          },
        },
      }),
    );

    const routingHop = trace.steps[0].hops.find((h) => h.layer === 'routing')!;
    expect(routingHop.chosen).toBe('gpt-4o-mini');
    expect(routingHop.alternatives).toEqual(['cheap', 'local']);
    expect(routingHop.costEstimateCents).toBeCloseTo(2, 5);
  });

  it('leaves the provider hop opaque rather than calling it free', () => {
    const trace = traceFor(
      execution({ n1: { routing: { modelId: 'm', vendorModelId: 'v', providerId: 'p1' } } }),
    );

    const provider = trace.steps[0].hops.find((h) => h.layer === 'provider')!;
    expect(provider.costEstimateCents).toBeNull();
    expect(provider.opaqueCost).toBe(true);
    expect(trace.summary.opaqueHops).toBe(1);
  });

  it('flags a provider that served something other than what was asked', () => {
    const trace = traceFor(
      execution({ n1: { routing: { modelId: 'm', vendorModelId: 'gpt-4o', servedModel: 'gpt-4o-mini', providerId: 'p1' } } }),
    );
    expect(trace.summary.divergences).toHaveLength(1);
  });

  it('still shows hops for a node where every model failed', () => {
    // No attribution exists here, because nothing answered. A trace that
    // showed nothing would be silent about the most interesting node.
    const trace = traceFor(
      execution({ n1: { error: 'exhausted', triedModels: [{ modelId: 'cheap', reason: '429' }, { modelId: 'fast', reason: '500' }] } }),
    );

    expect(trace.steps[0].hops.map((h) => h.chosen)).toEqual(['cheap', 'fast']);
    expect(trace.steps[0].error).toContain('exhausted');
  });

  it('reads in the order the run happened, not the order the object was keyed', () => {
    const trace = traceFor(
      execution({
        later: { startedAt: 200, routing: { modelId: 'b' } },
        earlier: { startedAt: 100, routing: { modelId: 'a' } },
      }),
    );
    expect(trace.steps.map((s) => s.nodeId)).toEqual(['earlier', 'later']);
  });

  it('carries why this shape ran, including that it was a fallback', () => {
    const trace = traceFor(execution({}, { strategyKey: 'single', strategyChosenBy: 'fallback', strategyFallbackReason: 'it did not answer within 2000ms' }));

    expect(trace.strategyKey).toBe('single');
    expect(trace.strategyChosenBy).toBe('fallback');
    expect(trace.strategyFallbackReason).toContain('2000ms');
  });

  it('says nothing rather than inventing hops for a run that never routed', () => {
    const trace = traceFor(execution({ n1: { output: 'hi' } }));
    expect(trace.steps[0].hops).toEqual([]);
    expect(trace.summary.knownCostCents).toBe(0);
  });
});
