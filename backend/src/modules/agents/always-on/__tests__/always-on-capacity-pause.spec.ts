import { ALWAYS_ON_CAPACITY_ENV, planCapacity } from '../always-on-capacity';
import { ALWAYS_ON_TICK_JOB, capacityPause, capacityRefusal } from '../always-on.service';
import { AGENT, ORG, OWNER, alwaysOnAgent, world } from './always-on.harness';

/**
 * The plan's always-on agents (always-on-capacity.ts, includedAgents) and
 * CAPACITY_EXHAUSTED. Frane: a plan lapse pauses what it paid for and tells
 * the owner; the design: turning the plan back on resumes. Every number
 * here comes from the capacity data, never from the code under test.
 */
const id = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;

/** An organization on `plan` with `count` more always-on agents, turned on an hour apart, before AGENT. */
function crowded(plan: string, count: number, agentAlwaysOn: Record<string, any> = {}) {
  const w = world({ plan, agent: alwaysOnAgent({}, { enabledAt: new Date(Date.now() - 1000).toISOString(), ...agentAlwaysOn }) });
  for (let i = 1; i <= count; i++) {
    w.agents.seed(
      alwaysOnAgent(
        { id: id(i), name: `Agent ${i}` },
        { enabledAt: new Date(Date.now() - (count - i + 2) * 3_600_000).toISOString(), wakeOn: { timer: { everyMinutes: 30 }, channelIds: [] }, ownerChannel: null },
      ),
    );
  }
  return w;
}

const included = (plan: string) => planCapacity(plan).includedAgents as number;

describe('Always on capacity: turning one more on', () => {
  it('is refused past what the plan includes, naming the agents that are on', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit, { enabled: false, enabledAt: null });
    await expect(w.service.configure(AGENT, ORG, { enabled: true })).rejects.toThrow(
      capacityRefusal(limit, Array.from({ length: limit }, (_, i) => `Agent ${i + 1}`)),
    );
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(false);
  });

  it('is allowed while there is room, and records when it was turned on', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit - 1, { enabled: false, enabledAt: null });
    await w.service.configure(AGENT, ORG, { enabled: true });
    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved.enabled).toBe(true);
    expect(typeof saved.enabledAt).toBe('string');
  });

  it('a plan with no limit never refuses', async () => {
    expect(planCapacity('free').includedAgents).toBeNull();
    const w = crowded('free', 12, { enabled: false });
    await w.service.configure(AGENT, ORG, { enabled: true });
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(true);
  });

  it('the number is the install\'s data: ALWAYS_ON_PLAN_CAPACITY changes it', async () => {
    const before = process.env[ALWAYS_ON_CAPACITY_ENV];
    process.env[ALWAYS_ON_CAPACITY_ENV] = JSON.stringify({ free: { includedAgents: 1 } });
    try {
      const w = crowded('free', 1, { enabled: false });
      await expect(w.service.configure(AGENT, ORG, { enabled: true })).rejects.toThrow(/includes 1 always-on agent,/);
    } finally {
      if (before === undefined) delete process.env[ALWAYS_ON_CAPACITY_ENV];
      else process.env[ALWAYS_ON_CAPACITY_ENV] = before;
    }
  });

  it('an organization that tightened its own count is held to it', async () => {
    const w = crowded('business', 2, { enabled: false });
    await w.organizations.update({ id: ORG }, { settings: { alwaysOn: { includedAgents: 2 } } });
    await expect(w.service.configure(AGENT, ORG, { enabled: true })).rejects.toThrow(/includes 2 always-on agents, and 2 are on already/);
  });
});

describe('Always on capacity: a plan that no longer has room', () => {
  it('pauses the agent turned on last at its next wake, with CAPACITY_EXHAUSTED, and tells the owner what to do', async () => {
    const limit = included('pro');
    // More on than the plan includes now (it was business; it is pro now).
    const w = crowded('pro', limit);
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'the timer', dedupeKey: 't1' });

    expect(await w.service.process(AGENT, ORG)).toBe('paused');
    expect(w.startRun).not.toHaveBeenCalled();
    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved.enabled).toBe(false);
    expect(saved.pausedReason.code).toBe('CAPACITY_EXHAUSTED');
    expect(saved.pausedReason.message).toBe(capacityPause(limit, limit + 1).message);
    expect(saved.pausedReason.message).toContain(`Your plan includes ${limit} always-on agents, and ${limit + 1} were on.`);
    expect(saved.pausedReason.message).toMatch(/turns back on by itself when there is room: turn Always on off for another agent, or move to a plan that includes more/);
    expect(w.queue.repeatable.some((j) => j.id === `always-on-${AGENT}`)).toBe(false);
    expect(w.wakes.rows().every((r) => r.status === 'dropped' && r.note === 'paused: the plan has no room for it')).toBe(true);
    const note = w.notified.find((n) => n.type === 'agent.paused');
    expect(note).toMatchObject({ userIds: [OWNER], title: 'Support agent was paused', body: saved.pausedReason.message });
    // Its email says it comes back by itself.
    expect(note.email).toMatchObject({ template: 'agent.paused', params: { resumesItself: true } });
    expect(w.audited.some((a) => a.details?.reason?.code === 'CAPACITY_EXHAUSTED')).toBe(true);
  });

  it('an agent within what the plan includes keeps working', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit);
    const first = id(1);
    await w.service.wake(first, ORG, 'timer', { summary: 'the timer', dedupeKey: 't1' });
    expect(await w.service.process(first, ORG)).toBe('started');
  });
});

describe('Always on capacity: room again', () => {
  const pausedFor = (w: ReturnType<typeof world>, agentId: string) =>
    w.agents.update(
      { id: agentId },
      { alwaysOn: { ...w.agents.row(agentId)!.alwaysOn, enabled: false, pausedReason: capacityPause(3, 4) } },
    );

  it('turning another agent off turns the paused one back on, timer and all, and tells its owner', async () => {
    const w = crowded('pro', included('pro'));
    await pausedFor(w, AGENT);
    await w.service.configure(id(1), ORG, { enabled: false });

    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved.enabled).toBe(true);
    expect(saved.pausedReason).toBeNull();
    expect(w.queue.repeatable.some((j) => j.name === ALWAYS_ON_TICK_JOB && j.id === `always-on-${AGENT}`)).toBe(true);
    expect(w.notified.find((n) => n.title === 'Support agent is back on')).toMatchObject({ type: 'agent.report', userIds: [OWNER] });
  });

  it('another agent pausing for its own reason frees its place too', async () => {
    const w = crowded('pro', included('pro'));
    await pausedFor(w, AGENT);
    await w.service.pause(w.agents.row(id(2))!, { code: 'WAKE_LOOP', message: 'looped', detectedAt: new Date().toISOString() });
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(true);
  });

  it('the capacity check notices a plan with more room', async () => {
    const w = crowded('pro', included('pro'));
    await pausedFor(w, AGENT);
    expect(await w.service.resumeAllWithinCapacity()).toBe(0);
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(false);

    await w.organizations.update({ id: ORG }, { plan: 'business' });
    expect(await w.service.resumeAllWithinCapacity()).toBe(1);
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(true);
  });

  it('never turns on more than there is room for, oldest pause first', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit);
    await pausedFor(w, AGENT);
    await w.agents.update(
      { id: id(1) },
      { alwaysOn: { ...w.agents.row(id(1))!.alwaysOn, enabled: false, pausedReason: capacityPause(3, 4, new Date(Date.now() - 86_400_000)) } },
    );
    // limit - 1 on, two waiting, one place.
    expect(await w.service.resumeWithinCapacity(ORG)).toBe(1);
    expect(w.agents.row(id(1))!.alwaysOn.enabled).toBe(true);
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(false);
  });

  it('a pause for another reason is never resumed by capacity', async () => {
    const w = world({ plan: 'business', agent: alwaysOnAgent({}, { enabled: false, pausedReason: { code: 'WAKE_LOOP', message: 'looped', detectedAt: new Date().toISOString() } }) });
    expect(await w.service.resumeAllWithinCapacity()).toBe(0);
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(false);
  });
});
