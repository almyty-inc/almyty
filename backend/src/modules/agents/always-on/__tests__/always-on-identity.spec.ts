import { AGENT, ORG, OWNER, alwaysOnAgent, world } from './always-on.harness';

/**
 * An always-on agent that acts as itself (agentConfig.runAs 'agent',
 * agent_identity): its wakes run as the agent, and when the plan no longer
 * includes that they pause. Never quietly as the owner instead.
 */
describe('Always on and an agent that acts as itself', () => {
  const selfAgent = () => alwaysOnAgent({ agentConfig: { runAs: 'agent' } });
  const wakeAndProcess = async (w: ReturnType<typeof world>) => {
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'the timer', dedupeKey: 't1' });
    return w.service.process(AGENT, ORG);
  };

  it('runs as the agent, with no user, while the plan includes it', async () => {
    const w = world({ agent: selfAgent(), identityLicensed: true });
    expect(await wakeAndProcess(w)).toBe('started');
    const [, , userId, , opts] = w.startRun.mock.calls[0];
    expect(userId).toBeNull();
    expect(opts.principal).toMatchObject({ kind: 'agent', agentId: AGENT });
  });

  it('pauses, says why and tells the owner when the plan lapsed; nothing runs as the owner', async () => {
    const w = world({ agent: selfAgent(), identityLicensed: false });
    expect(await wakeAndProcess(w)).toBe('paused');
    expect(w.startRun).not.toHaveBeenCalled();
    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved).toMatchObject({ enabled: false, pausedReason: { code: 'IDENTITY_LAPSED' } });
    expect(w.notified.some((n) => n.type === 'agent.paused' && n.userIds[0] === OWNER)).toBe(true);
  });

  it('an agent acting as its owner runs as the owner whatever the plan', async () => {
    const w = world({ identityLicensed: false });
    expect(await wakeAndProcess(w)).toBe('started');
    expect(w.startRun.mock.calls[0][4].principal).toEqual({ kind: 'user', userId: OWNER, source: 'always_on' });
  });
});
