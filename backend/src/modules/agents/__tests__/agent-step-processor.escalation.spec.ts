import { AgentStepProcessor } from '../agent-step-processor';

/**
 * Tier 2 routing in the autonomous runtime: a verifier rejection moves the
 * revision to the next route candidate only when the flag is on and the
 * policy asks for it; the adjusted policy lives in working memory.
 */
describe('AgentStepProcessor.escalateRouteOnVerifyFail', () => {
  const call = (ctx: any, run: any, agent: any, panel: any, response: any) =>
    (AgentStepProcessor.prototype as any).escalateRouteOnVerifyFail.call(ctx, run, agent, panel, response);
  const policy = { objective: 'cheapest', escalation: { onVerifyFail: 'next-candidate', maxEscalations: 2 } };
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.MODEL_ROUTER_VERIFY_ESCALATION; process.env.MODEL_ROUTER_VERIFY_ESCALATION = 'true'; });
  afterEach(() => { if (saved === undefined) delete process.env.MODEL_ROUTER_VERIFY_ESCALATION; else process.env.MODEL_ROUTER_VERIFY_ESCALATION = saved; });

  it('moves the next revision to the following candidate and counts the escalation', () => {
    const emitEvent = jest.fn();
    const run: any = { id: 'r1', currentStep: 3, workingMemory: { verifyRevisions: 1 } };
    const agent: any = { modelConfig: { routing: policy } };
    call({ s: { emitEvent } }, run, agent, { passed: false, failures: [{ rule: 'cites source' }] }, { routing: { attempt: 1 } });
    expect(run.workingMemory.routing).toEqual({ ...policy, skipCandidates: 1 });
    expect(run.workingMemory.routeEscalations).toBe(1);
    expect(run.workingMemory.verifyRevisions).toBe(1);
    expect(emitEvent).toHaveBeenCalledWith('r1', 'route.escalated', expect.objectContaining({ step: 3, nextAttempt: 2 }));
  });

  it('keeps skipping from the plan position already reached on a second rejection', () => {
    const run: any = { id: 'r1', currentStep: 5, workingMemory: { routing: { ...policy, skipCandidates: 1 }, routeEscalations: 1 } };
    call({ s: { emitEvent: jest.fn() } }, run, { modelConfig: { routing: policy } }, { passed: false, failures: [] }, { routing: { attempt: 1 } });
    expect(run.workingMemory.routing.skipCandidates).toBe(2);
    expect(run.workingMemory.routeEscalations).toBe(2);
  });

  it('stops once the escalation budget is spent', () => {
    const emitEvent = jest.fn();
    const run: any = { id: 'r1', currentStep: 7, workingMemory: { routing: { ...policy, skipCandidates: 2 }, routeEscalations: 2 } };
    call({ s: { emitEvent } }, run, { modelConfig: { routing: policy } }, { passed: false, failures: [] }, { routing: { attempt: 1 } });
    expect(run.workingMemory.routeEscalations).toBe(2);
    expect(run.workingMemory.routing.skipCandidates).toBe(2);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('does nothing for a pinned provider, a policy without escalation, a passing verdict, or with the flag off', () => {
    const emitEvent = jest.fn();
    const pinned: any = { id: 'r1', currentStep: 1, workingMemory: {} };
    call({ s: { emitEvent } }, pinned, { modelConfig: { providerId: 'p1' } }, { passed: false, failures: [] }, undefined);
    expect(pinned.workingMemory.routing).toBeUndefined();
    const plain: any = { id: 'r1', currentStep: 1, workingMemory: {} };
    call({ s: { emitEvent } }, plain, { modelConfig: { routing: { objective: 'cheapest' } } }, { passed: false, failures: [] }, { routing: { attempt: 1 } });
    expect(plain.workingMemory.routing).toBeUndefined();
    const passed: any = { id: 'r1', currentStep: 1, workingMemory: {} };
    call({ s: { emitEvent } }, passed, { modelConfig: { routing: policy } }, { passed: true }, { routing: { attempt: 1 } });
    expect(passed.workingMemory.routing).toBeUndefined();
    process.env.MODEL_ROUTER_VERIFY_ESCALATION = 'false';
    const off: any = { id: 'r1', currentStep: 1, workingMemory: {} };
    call({ s: { emitEvent } }, off, { modelConfig: { routing: policy } }, { passed: false, failures: [] }, { routing: { attempt: 1 } });
    expect(off.workingMemory.routing).toBeUndefined();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
