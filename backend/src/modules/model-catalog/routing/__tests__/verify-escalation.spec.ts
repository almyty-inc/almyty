import { Model } from '../../../../entities/model.entity';
import { RoutingPolicy, selectCandidates } from '../model-router';
import { verifyEscalationEnabled } from '../router-config';
import { EscalationState, VerifyOutcome, decideEscalation, nextRoutingPolicy, planPosition, runWithVerifyEscalation } from '../verify-escalation';

const pass: VerifyOutcome = { passed: true };
const fail: VerifyOutcome = { passed: false, failures: [{ rule: 'cites a source', evidence: 'none given', checker: 'c1' }] };
const state = (over: Partial<EscalationState> = {}): EscalationState => ({ attempt: 1, candidateCount: 3, escalations: 0, ...over });
const next: RoutingPolicy = { objective: 'cheapest', escalation: { onVerifyFail: 'next-candidate' } };

describe('verifyEscalationEnabled', () => {
  it('is off unless MODEL_ROUTER_VERIFY_ESCALATION is a truthy word', () => {
    expect(verifyEscalationEnabled({})).toBe(false);
    expect(verifyEscalationEnabled({ MODEL_ROUTER_VERIFY_ESCALATION: '' })).toBe(false);
    expect(verifyEscalationEnabled({ MODEL_ROUTER_VERIFY_ESCALATION: 'false' })).toBe(false);
    expect(verifyEscalationEnabled({ MODEL_ROUTER_VERIFY_ESCALATION: '0' })).toBe(false);
    expect(verifyEscalationEnabled({ MODEL_ROUTER_VERIFY_ESCALATION: 'maybe' })).toBe(false);
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(verifyEscalationEnabled({ MODEL_ROUTER_VERIFY_ESCALATION: on })).toBe(true);
    }
  });

  it('reads process.env by default', () => {
    const before = process.env.MODEL_ROUTER_VERIFY_ESCALATION;
    delete process.env.MODEL_ROUTER_VERIFY_ESCALATION;
    expect(verifyEscalationEnabled()).toBe(false);
    process.env.MODEL_ROUTER_VERIFY_ESCALATION = 'true';
    expect(verifyEscalationEnabled()).toBe(true);
    if (before === undefined) delete process.env.MODEL_ROUTER_VERIFY_ESCALATION;
    else process.env.MODEL_ROUTER_VERIFY_ESCALATION = before;
  });
});

describe('decideEscalation', () => {
  it('accepts a passing verdict whatever the policy or flag', () => {
    expect(decideEscalation(undefined, pass, state(), false).action).toBe('accept');
    expect(decideEscalation(next, pass, state(), true).action).toBe('accept');
    expect(decideEscalation({ escalation: { onVerifyFail: 'stop' } }, pass, state(), true).action).toBe('accept');
  });

  it('stops on a failed verdict while the flag is off, even with a next-candidate policy', () => {
    const d = decideEscalation(next, fail, state(), false);
    expect(d).toEqual({ action: 'stop', reason: expect.stringContaining('MODEL_ROUTER_VERIFY_ESCALATION') });
  });

  it('defaults to the environment flag, which is off in tests', () => {
    delete process.env.MODEL_ROUTER_VERIFY_ESCALATION;
    expect(decideEscalation(next, fail, state()).action).toBe('stop');
  });

  it('stops when the route carries no escalation policy or asks to stop', () => {
    expect(decideEscalation(undefined, fail, state(), true)).toEqual({ action: 'stop', reason: 'no escalation policy on the route' });
    expect(decideEscalation({ objective: 'fastest' }, fail, state(), true).action).toBe('stop');
    expect(decideEscalation({ escalation: { onVerifyFail: 'stop' } }, fail, state(), true)).toEqual({ action: 'stop', reason: "escalation policy is 'stop'" });
  });

  it('escalates to the next candidate with the answered ones skipped', () => {
    const d = decideEscalation(next, fail, state({ attempt: 1, candidateCount: 3 }), true);
    expect(d).toEqual({
      action: 'escalate',
      nextAttempt: 2,
      skipCandidates: 1,
      reason: 'verifier rejected candidate 1 of 3 (1 failure); trying candidate 2',
    });
    const later = decideEscalation(next, { passed: false }, state({ attempt: 2, candidateCount: 3, escalations: 1 }), true);
    expect(later).toMatchObject({ action: 'escalate', nextAttempt: 3, skipCandidates: 2, reason: expect.stringContaining('0 failures') });
  });

  it('stops at the end of the plan', () => {
    expect(decideEscalation(next, fail, state({ attempt: 3, candidateCount: 3, escalations: 2 }), true)).toEqual({
      action: 'stop',
      reason: 'escalation budget exhausted (2/2)',
    });
    expect(decideEscalation(next, fail, state({ attempt: 1, candidateCount: 1 }), true)).toEqual({ action: 'stop', reason: 'no escalation budget' });
  });

  it('honours maxEscalations, capped by the plan length', () => {
    const capped: RoutingPolicy = { escalation: { onVerifyFail: 'next-candidate', maxEscalations: 1 } };
    expect(decideEscalation(capped, fail, state({ attempt: 1, candidateCount: 5, escalations: 0 }), true).action).toBe('escalate');
    expect(decideEscalation(capped, fail, state({ attempt: 2, candidateCount: 5, escalations: 1 }), true)).toEqual({
      action: 'stop',
      reason: 'escalation budget exhausted (1/1)',
    });
    const zero: RoutingPolicy = { escalation: { onVerifyFail: 'next-candidate', maxEscalations: 0 } };
    expect(decideEscalation(zero, fail, state({ attempt: 1, candidateCount: 5 }), true)).toEqual({ action: 'stop', reason: 'no escalation budget' });
    const generous: RoutingPolicy = { escalation: { onVerifyFail: 'next-candidate', maxEscalations: 99 } };
    expect(decideEscalation(generous, fail, state({ attempt: 2, candidateCount: 2, escalations: 1 }), true).action).toBe('stop');
    const fractional: RoutingPolicy = { escalation: { onVerifyFail: 'next-candidate', maxEscalations: 1.9 } };
    expect(decideEscalation(fractional, fail, state({ attempt: 2, candidateCount: 5, escalations: 1 }), true).action).toBe('stop');
    const negative: RoutingPolicy = { escalation: { onVerifyFail: 'next-candidate', maxEscalations: -3 } };
    expect(decideEscalation(negative, fail, state({ attempt: 1, candidateCount: 5 }), true).action).toBe('stop');
  });

  it('never escalates a cancelled request or one whose position is unknown', () => {
    expect(decideEscalation(next, fail, state({ aborted: true }), true)).toEqual({ action: 'stop', reason: 'request cancelled' });
    expect(decideEscalation(next, fail, state({ attempt: 0 }), true).action).toBe('stop');
    expect(decideEscalation(next, fail, state({ attempt: 1.5 }), true).action).toBe('stop');
  });

  it('leaves the original policy alone when building the re-run policy', () => {
    const d = decideEscalation(next, fail, state(), true);
    if (d.action !== 'escalate') throw new Error('expected escalate');
    const rerun = nextRoutingPolicy(next, d);
    expect(rerun).toEqual({ objective: 'cheapest', escalation: { onVerifyFail: 'next-candidate' }, skipCandidates: 1 });
    expect(next.skipCandidates).toBeUndefined();
  });
});

describe('selectCandidates with skipCandidates', () => {
  const card = (id: string, price: number): Model =>
    Object.assign(new Model(), {
      id,
      providerId: 'p',
      endpointRef: null,
      status: 'active',
      validationStatus: 'passed',
      privacyTier: 'public',
      region: null,
      capabilities: {},
      pricing: { inPerMTok: price, outPerMTok: price, currency: 'USD' },
      pricingOverride: null,
      measuredLatencyMs: null,
      modelVersionId: null,
      vendorModelId: id,
    });
  const cards = [card('dear', 9), card('cheap', 1), card('mid', 5)];

  it('starts the ranked plan after the skipped candidates and explains them in rejected', () => {
    const { candidates, rejected } = selectCandidates(cards, { objective: 'cheapest', skipCandidates: 1 });
    expect(candidates.map((c) => c.modelId)).toEqual(['mid', 'dear']);
    expect(rejected).toEqual([{ modelId: 'cheap', reason: 'skipped after verify escalation' }]);
  });

  it('applies to an explicit fallback chain too', () => {
    const { candidates, rejected } = selectCandidates(cards, { fallbackChain: ['dear', 'mid', 'cheap'], skipCandidates: 2 });
    expect(candidates.map((c) => c.modelId)).toEqual(['cheap']);
    expect(rejected.map((r) => r.modelId)).toEqual(['dear', 'mid']);
  });

  it('is a no-op at zero, negative or absent, and empties the plan past its end', () => {
    expect(selectCandidates(cards, { skipCandidates: 0 }).candidates).toHaveLength(3);
    expect(selectCandidates(cards, { skipCandidates: -2 }).candidates).toHaveLength(3);
    expect(selectCandidates(cards, {}).candidates).toHaveLength(3);
    expect(selectCandidates(cards, { skipCandidates: 7 }).candidates).toHaveLength(0);
  });
});

describe('runWithVerifyEscalation', () => {
  const plan = ['cheap', 'mid', 'dear'];
  // A stand-in for callRouted: answer from the first candidate after the skip.
  const run = jest.fn(async (policy: RoutingPolicy) => {
    const skip = policy.skipCandidates ?? 0;
    return { output: plan[skip], attempt: skip + 1 };
  });
  beforeEach(() => run.mockClear());

  it('returns the first answer a verifier accepts, with the trail of rejected ones', async () => {
    const verify = jest.fn(async (output: string, _attempt: number) => (output === 'dear' ? pass : fail));
    const res = await runWithVerifyEscalation({ policy: next, candidateCount: 3, run, verify, enabled: true });
    expect(res.output).toBe('dear');
    expect(res.attempt).toBe(3);
    expect(res.escalations).toBe(2);
    expect(run.mock.calls.map((c) => c[0].skipCandidates)).toEqual([undefined, 1, 2]);
    expect(verify.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
    expect(res.trail.map((t) => [t.attempt, t.decision, t.failures])).toEqual([
      [1, 'escalate', 1],
      [2, 'escalate', 1],
      [3, 'accept', 0],
    ]);
  });

  it('returns the last rejected answer when the plan runs out, marked as such', async () => {
    const verify = jest.fn(async () => fail);
    const res = await runWithVerifyEscalation({ policy: next, candidateCount: 2, run, verify, enabled: true });
    expect(res.output).toBe('mid');
    expect(res.verify.passed).toBe(false);
    expect(res.escalations).toBe(1);
    expect(res.trail.map((t) => t.decision)).toEqual(['escalate', 'stop']);
    expect(res.trail[1].reason).toMatch(/budget exhausted/);
  });

  it('runs exactly once with the flag off', async () => {
    const verify = jest.fn(async () => fail);
    const res = await runWithVerifyEscalation({ policy: next, candidateCount: 3, run, verify, enabled: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(res.output).toBe('cheap');
    expect(res.trail).toEqual([{ attempt: 1, decision: 'stop', reason: expect.stringContaining('disabled'), failures: 1 }]);
  });

  it('stops after the current answer when the caller aborts', async () => {
    const controller = new AbortController();
    const verify = jest.fn(async () => {
      controller.abort();
      return fail;
    });
    const res = await runWithVerifyEscalation({ policy: next, candidateCount: 3, run, verify, enabled: true, signal: controller.signal });
    expect(run).toHaveBeenCalledTimes(1);
    expect(res.trail[0]).toMatchObject({ decision: 'stop', reason: 'request cancelled' });
  });

  it('propagates a failing call instead of swallowing it', async () => {
    const boom = jest.fn(async () => {
      throw Object.assign(new Error('all candidates failed'), { code: 'ROUTE_EXHAUSTED' });
    });
    await expect(runWithVerifyEscalation({ policy: next, candidateCount: 3, run: boom, verify: async () => pass, enabled: true })).rejects.toMatchObject({ code: 'ROUTE_EXHAUSTED' });
  });

  it('walks an unknown-length plan until the re-run reports NO_ROUTE, keeping the last answer', async () => {
    const short = jest.fn(async (policy: RoutingPolicy) => {
      const skip = policy.skipCandidates ?? 0;
      if (skip >= 2) throw Object.assign(new Error('No registered model satisfies the routing policy'), { code: 'NO_ROUTE', name: 'NoRouteError' });
      return { output: plan[skip], attempt: 1 + skip };
    });
    const verify = jest.fn(async () => fail);
    const res = await runWithVerifyEscalation({ policy: next, run: short, verify, enabled: true });
    expect(short).toHaveBeenCalledTimes(3);
    expect(res.output).toBe('mid');
    expect(res.attempt).toBe(2);
    expect(res.escalations).toBe(1);
    expect(res.trail.map((t) => [t.attempt, t.decision])).toEqual([[1, 'escalate'], [2, 'escalate'], [2, 'stop']]);
    expect(res.trail[2].reason).toBe('no further candidate in the plan');
  });

  it('does not swallow NO_ROUTE on the first call', async () => {
    const none = jest.fn(async () => {
      throw Object.assign(new Error('nothing registered'), { code: 'NO_ROUTE' });
    });
    await expect(runWithVerifyEscalation({ policy: next, run: none, verify: async () => pass, enabled: true })).rejects.toMatchObject({ code: 'NO_ROUTE' });
  });
});

describe('decideEscalation without a known plan length', () => {
  it('escalates on the policy alone and leaves the end of the plan to the re-run', () => {
    const d = decideEscalation(next, fail, { attempt: 4, escalations: 3 }, true);
    expect(d).toEqual({ action: 'escalate', nextAttempt: 5, skipCandidates: 4, reason: 'verifier rejected candidate 4 (1 failure); trying candidate 5' });
    const capped: RoutingPolicy = { escalation: { onVerifyFail: 'next-candidate', maxEscalations: 2 } };
    expect(decideEscalation(capped, fail, { attempt: 3, escalations: 2 }, true)).toEqual({ action: 'stop', reason: 'escalation budget exhausted (2/2)' });
  });
});

describe('planPosition', () => {
  it('adds the skip back onto the routed attempt', () => {
    expect(planPosition(1, undefined)).toBe(1);
    expect(planPosition(undefined, { skipCandidates: 2 })).toBe(3);
    expect(planPosition(2, { skipCandidates: 1 })).toBe(3);
    expect(planPosition(1, { skipCandidates: -4 })).toBe(1);
  });
});
