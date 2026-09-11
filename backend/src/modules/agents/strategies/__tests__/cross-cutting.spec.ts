import { evaluateBudget } from '../budget-policy';
import { ourHop, providerHop, summariseTrace } from '../route-trace';

/**
 * Gate 7, cross-cutting:
 *   budget stops a run early on verifier pass with the projection recorded;
 *   route trace shows a provider-side hop and flags requested-versus-served
 *   divergence.
 */
describe('budget stops a run, and records why', () => {
  const projection = { spentCents: 40, nextStageCents: 30, verifierPassed: true };

  it('stops as soon as the verifier passes, rather than spending the rest', () => {
    const verdict = evaluateBudget({ stopWhen: { verifierPasses: true } }, projection);
    expect(verdict.action).toBe('stop');
    expect(verdict).toMatchObject({ reason: expect.stringContaining('verifier passed') });
  });

  it('carries the projection that caused the decision, every time', () => {
    for (const policy of [
      undefined,
      { stopWhen: { verifierPasses: true } },
      { ceilingPerRun: 50 },
      { ceilingPerRun: 1000 },
    ]) {
      expect(evaluateBudget(policy, projection).projection).toEqual(projection);
    }
  });

  it('says what the ceiling decision was based on, in cents', () => {
    const verdict = evaluateBudget({ ceilingPerRun: 50 }, { spentCents: 40, nextStageCents: 30 });
    expect(verdict.action).toBe('stop');
    expect(verdict).toMatchObject({ reason: expect.stringContaining('70 cents, over the 50 ceiling') });
    expect((verdict as { reason: string }).reason).toContain('spent 40');
  });

  it('honours onExceed, so a run can degrade or ask instead of stopping', () => {
    const over = { spentCents: 40, nextStageCents: 30 };
    expect(evaluateBudget({ ceilingPerRun: 50, onExceed: 'degrade' }, over).action).toBe('degrade');
    expect(evaluateBudget({ ceilingPerRun: 50, onExceed: 'ask' }, over).action).toBe('ask');
  });

  it('prefers finishing to running out: a stop rule beats the ceiling', () => {
    // Both would fire. The recorded reason should say the work was done,
    // not that the money ran out, because those are different facts.
    const verdict = evaluateBudget(
      { ceilingPerRun: 50, stopWhen: { verifierPasses: true } },
      { spentCents: 40, nextStageCents: 30, verifierPassed: true },
    );
    expect((verdict as { reason: string }).reason).toContain('verifier passed');
  });

  it('stops on confidence and on marginal gain, quoting the numbers', () => {
    expect(evaluateBudget({ stopWhen: { confidenceAbove: 0.9 } }, { spentCents: 1, nextStageCents: 1, confidence: 0.95 })).toMatchObject({
      action: 'stop',
      reason: expect.stringContaining('0.9'),
    });
    expect(
      evaluateBudget({ stopWhen: { marginalGainBelow: 0.05 } }, { spentCents: 1, nextStageCents: 1, marginalGain: 0.01 }),
    ).toMatchObject({ action: 'stop', reason: expect.stringContaining('0.05') });
  });

  it('continues when nothing says otherwise', () => {
    expect(evaluateBudget({ ceilingPerRun: 1000 }, { spentCents: 1, nextStageCents: 1 }).action).toBe('continue');
    expect(evaluateBudget(undefined, { spentCents: 999, nextStageCents: 999 }).action).toBe('continue');
  });
});

describe('the route trace does not pretend to know what it cannot', () => {
  it('marks a provider-side hop opaque rather than costing it zero', () => {
    const hop = providerHop({ layer: 'provider', decidedBy: 'Straitly', chosen: 'anthropic/claude', reason: 'aggregator chose a healthy provider' });
    expect(hop).toMatchObject({ opaqueCost: true, costEstimateCents: null });
    // The distinction that matters: null is not zero.
    expect(hop.costEstimateCents).not.toBe(0);
  });

  it('flags requested-versus-served divergence instead of smoothing it', () => {
    const hop = providerHop({
      layer: 'provider',
      decidedBy: 'OpenRouter',
      chosen: 'anthropic/claude',
      reason: 'routed downstream',
      requestedModel: 'claude-opus-4-6',
      servedModel: 'claude-sonnet-4-6',
    });
    expect(hop.divergent).toBe(true);
  });

  it('does not flag a hop that served what was asked', () => {
    const hop = providerHop({
      layer: 'provider',
      decidedBy: 'OpenRouter',
      chosen: 'x',
      reason: 'routed downstream',
      requestedModel: 'claude-opus-4-6',
      servedModel: 'claude-opus-4-6',
    });
    expect(hop.divergent).toBeUndefined();
  });

  it('prices our own hops, because those we do know', () => {
    const hop = ourHop({ layer: 'routing', decidedBy: 'cheapest policy', chosen: 'card-a', reason: 'rank 1', costEstimateCents: 12 });
    expect(hop).toMatchObject({ opaqueCost: false, costEstimateCents: 12 });
  });

  it('records a capability lost to a compatibility path, so the downgrade is not silent', () => {
    const hop = ourHop({
      layer: 'routing',
      decidedBy: 'requirement needed tools',
      chosen: 'zai via chat_completions',
      reason: 'the native path does not expose tool use here',
      capabilitiesDropped: ['extended thinking'],
    });
    expect(hop.capabilitiesDropped).toEqual(['extended thinking']);
  });

  it('summarises what is known, what is not, and what diverged', () => {
    const summary = summariseTrace([
      ourHop({ layer: 'orchestrator', decidedBy: 'orchestrator', chosen: 'cascade', reason: 'simple edit', costEstimateCents: 2 }),
      ourHop({ layer: 'routing', decidedBy: 'cheapest', chosen: 'card-a', reason: 'rank 1', costEstimateCents: 10, capabilitiesDropped: ['vision'] }),
      providerHop({ layer: 'provider', decidedBy: 'Straitly', chosen: 'x', reason: 'downstream', requestedModel: 'a', servedModel: 'b' }),
    ]);
    expect(summary.knownCostCents).toBe(12);
    expect(summary.opaqueHops).toBe(1);
    expect(summary.divergences).toHaveLength(1);
    expect(summary.capabilitiesDropped).toEqual(['vision']);
  });
});
