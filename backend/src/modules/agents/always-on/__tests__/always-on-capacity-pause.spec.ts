import { ALWAYS_ON_CAPACITY_ENV, planCapacity } from '../always-on-capacity';
import { ALWAYS_ON_TICK_JOB, capacityPause, capacityRefusal } from '../always-on.service';
import { AGENT, ORG, OWNER, alwaysOnAgent, world } from './always-on.harness';

/**
 * The plan's always-on agents (always-on-capacity.ts, includedAgents) and
 * CAPACITY_EXHAUSTED. Frane (2026-10-08): the limit counts only agents
 * whose home is a hosted machine (`alwaysOn.home.environmentId`); an agent
 * on the owner's own machines, or with no machine, is never limited on any
 * plan, and a plan change (Free to Pro, the referral reward) never pauses
 * one. Every number here comes from the capacity data, never from the code
 * under test.
 */
const id = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const ENV_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOSTED = { home: { environmentId: ENV_ID } };

/** Where the agents in an organization live. */
type Where = 'hosted' | 'own' | 'none';
const placed = (where: Where): { overrides: Record<string, any>; alwaysOn: Record<string, any> } =>
  where === 'hosted'
    ? { overrides: {}, alwaysOn: HOSTED }
    : where === 'own'
      ? { overrides: { agentConfig: { runnerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runnerLabels: { os: 'mac' } } }, alwaysOn: {} }
      : { overrides: {}, alwaysOn: {} };

/** An organization on `plan` with `count` more always-on agents, turned on an hour apart, before AGENT. */
function crowded(plan: string, count: number, agentAlwaysOn: Record<string, any> = {}, where: Where = 'hosted') {
  const p = placed(where);
  const w = world({
    plan,
    agent: alwaysOnAgent(p.overrides, { enabledAt: new Date(Date.now() - 1000).toISOString(), ...p.alwaysOn, ...agentAlwaysOn }),
  });
  for (let i = 1; i <= count; i++) {
    w.agents.seed(
      alwaysOnAgent(
        { id: id(i), name: `Agent ${i}`, ...p.overrides },
        {
          enabledAt: new Date(Date.now() - (count - i + 2) * 3_600_000).toISOString(),
          wakeOn: { timer: { everyMinutes: 30 }, channelIds: [] },
          ownerChannel: null,
          ...p.alwaysOn,
        },
      ),
    );
  }
  return w;
}

const included = (plan: string) => planCapacity(plan).includedAgents as number;

/** Run the agent's next wake and say what became of it. */
async function nextWake(w: ReturnType<typeof world>, agentId: string, key = 't1') {
  await w.service.wake(agentId, ORG, 'timer', { summary: 'the timer', dedupeKey: `${agentId}-${key}` });
  return w.service.process(agentId, ORG);
}

/** Every plan, each held to one included agent by the install's data. */
async function withOneIncludedEverywhere(fn: () => Promise<void>) {
  const before = process.env[ALWAYS_ON_CAPACITY_ENV];
  process.env[ALWAYS_ON_CAPACITY_ENV] = JSON.stringify(
    Object.fromEntries(['free', 'pro', 'business', 'enterprise'].map((p) => [p, { includedAgents: 1 }])),
  );
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env[ALWAYS_ON_CAPACITY_ENV];
    else process.env[ALWAYS_ON_CAPACITY_ENV] = before;
  }
}

describe('Always on capacity: agents on your own machines, or with no machine, are never limited', () => {
  for (const where of ['own', 'none'] as const) {
    const what = where === 'own' ? 'on its owner\'s own machine' : 'with no machine';
    for (const plan of ['free', 'pro', 'business', 'enterprise']) {
      it(`an agent ${what} is never paused on ${plan}, however many are on`, async () => {
        await withOneIncludedEverywhere(async () => {
          const w = crowded(plan, 6, {}, where);
          expect(await nextWake(w, AGENT)).toBe('started');
          for (let i = 1; i <= 6; i++) expect(await nextWake(w, id(i))).not.toBe('paused');
          expect(w.agents.rows().every((a) => a.alwaysOn.enabled && !a.alwaysOn.pausedReason)).toBe(true);
          expect(w.notified.some((n) => n.type === 'agent.paused')).toBe(false);
        });
      });

      it(`an agent ${what} may be turned on on ${plan}, however many are on`, async () => {
        await withOneIncludedEverywhere(async () => {
          const w = crowded(plan, 6, { enabled: false, enabledAt: null }, where);
          await w.service.configure(AGENT, ORG, { enabled: true });
          expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(true);
        });
      });
    }
  }

  it('the agent page names no limit for it and counts no agents against the plan', async () => {
    const w = crowded('pro', included('pro') + 2, {}, 'own');
    const view = await w.service.view(AGENT, ORG);
    expect(view.hostedHome).toBe(false);
    expect(view.hostedAgentsOn).toBe(0);
  });

  it('a hosted environment for its tools alone (agentConfig.environmentId) is not a hosted home', async () => {
    await withOneIncludedEverywhere(async () => {
      const w = crowded('pro', 3, {}, 'none');
      await w.agents.update({ id: AGENT }, { agentConfig: { environmentId: ENV_ID } });
      expect(await nextWake(w, AGENT)).toBe('started');
    });
  });
});

describe('Always on capacity: a plan change never pauses an agent without a hosted home', () => {
  for (const where of ['own', 'none'] as const) {
    it(`Free to Pro, with more ${where === 'own' ? 'own-machine' : 'machine-less'} agents on than Pro includes, pauses nothing`, async () => {
      const limit = included('pro');
      expect(planCapacity('free').includedAgents).toBeNull();
      const w = crowded('free', limit + 3, {}, where);
      // The upgrade, by payment or the referral reward: only the plan changes.
      await w.organizations.update({ id: ORG }, { plan: 'pro' });

      expect(await nextWake(w, AGENT)).toBe('started');
      for (let i = 1; i <= limit + 3; i++) expect(await nextWake(w, id(i))).not.toBe('paused');
      expect(await w.service.resumeAllWithinCapacity()).toBe(0);
      expect(w.agents.rows().every((a) => a.alwaysOn.enabled && !a.alwaysOn.pausedReason)).toBe(true);
      expect(w.notified.some((n) => n.type === 'agent.paused')).toBe(false);
    });
  }

  it('an own-machine agent left paused for plan room comes back without taking a place', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit);
    // One own-machine agent, waiting with an old CAPACITY_EXHAUSTED; the hosted ones fill the plan.
    await w.agents.update(
      { id: AGENT },
      { alwaysOn: { ...w.agents.row(AGENT)!.alwaysOn, home: null, enabled: false, pausedReason: capacityPause(limit, limit + 1) } },
    );
    expect(await w.service.resumeAllWithinCapacity()).toBe(1);
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(true);
  });
});

describe('Always on capacity: turning one more hosted-home agent on', () => {
  it('is refused past what the plan includes, naming the hosted-home agents that are on', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit, { enabled: false, enabledAt: null });
    await expect(w.service.configure(AGENT, ORG, { enabled: true })).rejects.toThrow(
      capacityRefusal(limit, Array.from({ length: limit }, (_, i) => `Agent ${i + 1}`)),
    );
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(false);
  });

  it('own-machine agents that are on take no place from it', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit + 2, { enabled: false, enabledAt: null, ...HOSTED }, 'own');
    await w.service.configure(AGENT, ORG, { enabled: true });
    expect(w.agents.row(AGENT)!.alwaysOn.enabled).toBe(true);
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
      await expect(w.service.configure(AGENT, ORG, { enabled: true })).rejects.toThrow(
        /includes 1 always-on agent on hosted machines,/,
      );
    } finally {
      if (before === undefined) delete process.env[ALWAYS_ON_CAPACITY_ENV];
      else process.env[ALWAYS_ON_CAPACITY_ENV] = before;
    }
  });

  it('an organization that tightened its own count is held to it', async () => {
    const w = crowded('business', 2, { enabled: false });
    await w.organizations.update({ id: ORG }, { settings: { alwaysOn: { includedAgents: 2 } } });
    await expect(w.service.configure(AGENT, ORG, { enabled: true })).rejects.toThrow(
      /includes 2 always-on agents on hosted machines, and 2 are on already/,
    );
  });

  it('the agent page names the limit and the hosted-home agents on', async () => {
    const limit = included('pro');
    const w = crowded('pro', limit - 1);
    const view = await w.service.view(AGENT, ORG);
    expect(view.hostedHome).toBe(true);
    expect(view.hostedAgentsOn).toBe(limit);
    expect(view.capacity.includedAgents).toBe(limit);
  });
});

describe('Always on capacity: a plan that no longer has room for a hosted-home agent', () => {
  it('pauses the agent turned on last at its next wake, with CAPACITY_EXHAUSTED, and tells the owner what to do', async () => {
    const limit = included('pro');
    // More on than the plan includes now (it was business; it is pro now).
    const w = crowded('pro', limit);
    expect(await nextWake(w, AGENT)).toBe('paused');
    expect(w.startRun).not.toHaveBeenCalled();
    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved.enabled).toBe(false);
    expect(saved.pausedReason.code).toBe('CAPACITY_EXHAUSTED');
    expect(saved.pausedReason.message).toBe(capacityPause(limit, limit + 1).message);
    expect(saved.pausedReason.message).toContain(
      `Your plan includes ${limit} always-on agents on hosted machines, and ${limit + 1} were on.`,
    );
    expect(saved.pausedReason.message).toMatch(/turns back on by itself when there is room/);
    expect(w.queue.repeatable.some((j) => j.id === `always-on-${AGENT}`)).toBe(false);
    expect(w.wakes.rows().every((r) => r.status === 'dropped' && r.note === 'paused: the plan has no room for it')).toBe(true);
    const note = w.notified.find((n) => n.type === 'agent.paused');
    expect(note).toMatchObject({ userIds: [OWNER], title: 'Support agent was paused', body: saved.pausedReason.message });
    // Its email says it comes back by itself.
    expect(note.email).toMatchObject({ template: 'agent.paused', params: { resumesItself: true } });
    expect(w.audited.some((a) => a.details?.reason?.code === 'CAPACITY_EXHAUSTED')).toBe(true);
  });

  it('an agent within what the plan includes keeps working', async () => {
    const w = crowded('pro', included('pro'));
    expect(await nextWake(w, id(1))).toBe('started');
  });

  it('pauses, then turns back on by itself once the plan has room', async () => {
    const w = crowded('pro', included('pro'));
    expect(await nextWake(w, AGENT)).toBe('paused');
    expect(await w.service.resumeAllWithinCapacity()).toBe(0);

    await w.organizations.update({ id: ORG }, { plan: 'business' });
    expect(await w.service.resumeAllWithinCapacity()).toBe(1);
    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved.enabled).toBe(true);
    expect(saved.pausedReason).toBeNull();
    expect(w.queue.repeatable.some((j) => j.name === ALWAYS_ON_TICK_JOB && j.id === `always-on-${AGENT}`)).toBe(true);
    expect(await nextWake(w, AGENT, 't2')).toBe('started');
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
