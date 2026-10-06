import { AgentRunStatus } from '../../../../entities/agent-run.entity';
import { ALWAYS_ON_TICK_JOB, ALWAYS_ON_WAKE_JOB, LEGACY_HEARTBEAT_JOB, MAX_QUEUED_WAKES, sameAddress } from '../always-on.service';
import {
  AGENT,
  GW_HOOK,
  GW_SLACK,
  ORG,
  OWNER,
  SLACK,
  TOOL_READ,
  TOOL_WRITE,
  alwaysOnAgent,
  finishRun,
  world,
} from './always-on.harness';

const queued = (w: ReturnType<typeof world>) => w.wakes.rows().filter((r) => r.status === 'queued');

describe('Always on: wakes', () => {
  it('keeps one wake per dedupe key and asks the queue to look at the agent', async () => {
    const w = world();
    const first = await w.service.wake(AGENT, ORG, 'webhook', { summary: 'push to main', dedupeKey: 'webhook:abc' });
    const again = await w.service.wake(AGENT, ORG, 'webhook', { summary: 'push to main', dedupeKey: 'webhook:abc' });
    expect(first).not.toBeNull();
    expect(again).toBeNull();
    expect(w.wakes.rows()).toHaveLength(1);
    expect(w.queue.added.some((j) => j.name === ALWAYS_ON_WAKE_JOB && j.data.agentId === AGENT)).toBe(true);
  });

  it('keeps no wake for an agent that is not always on', async () => {
    const w = world({ agent: alwaysOnAgent({}, { enabled: false }) });
    expect(await w.service.wake(AGENT, ORG, 'manual', { summary: 'now', dedupeKey: 'm1' })).toBeNull();
    expect(w.wakes.rows()).toHaveLength(0);
  });

  it('folds the oldest away when more than the inbox holds are waiting', async () => {
    const w = world();
    for (let i = 0; i < MAX_QUEUED_WAKES + 3; i++) {
      w.wakes.seed({ agentId: AGENT, organizationId: ORG, source: 'webhook', summary: `#${i}`, dedupeKey: `k${i}`, status: 'queued', createdAt: new Date(Date.now() - (1000 - i) * 1000) });
    }
    await w.service.wake(AGENT, ORG, 'webhook', { summary: 'newest', dedupeKey: 'newest' });
    expect(queued(w)).toHaveLength(MAX_QUEUED_WAKES);
    const coalesced = w.wakes.rows().filter((r) => r.status === 'coalesced').map((r) => r.summary);
    expect(coalesced).toEqual(expect.arrayContaining(['#0', '#1', '#2', '#3']));
    expect(coalesced).not.toContain('newest');
  });

  it('a timer tick in the same minute is one wake', async () => {
    const w = world();
    const at = new Date('2026-10-06T10:30:10Z');
    await w.service.tick(AGENT, ORG, at);
    await w.service.tick(AGENT, ORG, new Date('2026-10-06T10:30:50Z'));
    expect(w.wakes.rows()).toHaveLength(1);
    expect(w.wakes.rows()[0].source).toBe('timer');
  });
});

describe('Always on: turning wakes into runs', () => {
  it('starts one run on the standing thread, as the owner, on the agent\'s own limits', async () => {
    const w = world();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'the timer (every 30 minutes)', dedupeKey: 't1' });
    await w.service.wake(AGENT, ORG, 'webhook', { summary: 'the webhook "GitHub" received: push', dedupeKey: 'h1' });

    expect(await w.service.process(AGENT, ORG)).toBe('started');

    expect(w.startRun).toHaveBeenCalledTimes(1);
    const [agentId, org, userId, input, opts] = w.startRun.mock.calls[0];
    expect([agentId, org, userId]).toEqual([AGENT, ORG, OWNER]);
    expect(opts.agentLimits).toBe(true);
    expect(opts.maxSteps).toBeUndefined();
    expect(opts.principal).toEqual({ kind: 'user', userId: OWNER, source: 'always_on' });
    expect(opts.metadata.triggerType).toBe('always_on');
    expect(input).toContain('Keep the refund queue empty.');
    expect(input.indexOf('the timer')).toBeLessThan(input.indexOf('the webhook'));
    // Both wakes went to that run.
    expect(w.wakes.rows().every((r) => r.status === 'consumed' && r.runId === 'run-1')).toBe(true);
    // The thread and the live run are remembered on the agent.
    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved.standingConversationId).toBe('conv-1');
    expect(saved.liveRunId).toBe('run-1');
  });

  it('continues the same conversation on the next wake', async () => {
    const w = world();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    await w.service.process(AGENT, ORG);
    await finishRun(w, 'run-1');
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't2' });
    await w.service.process(AGENT, ORG);
    expect(w.startRun).toHaveBeenCalledTimes(2);
    expect(w.startRun.mock.calls[1][4].conversationId).toBe('conv-1');
  });

  it('a wake during a live run joins that run instead of starting a second one', async () => {
    const w = world();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    await w.service.process(AGENT, ORG);
    await w.service.wake(AGENT, ORG, 'webhook', { summary: 'the webhook "GitHub" received: issue opened', dedupeKey: 'h2' });

    expect(await w.service.process(AGENT, ORG)).toBe('live');
    expect(w.startRun).toHaveBeenCalledTimes(1);
    expect(queued(w)).toHaveLength(1);

    // The run's next step picks it up.
    const run = w.runs.row('run-1')!;
    expect(await w.service.drainInto(run)).toBe(1);
    const note = w.messages.rows().find((m) => m.conversationId === 'conv-1');
    expect(note.content).toContain('While you were working:');
    expect(note.content).toContain('issue opened');
    expect(w.wakes.rows().find((r) => r.dedupeKey === 'h2').runId).toBe('run-1');
    expect(run.metadata.wakeIds).toContain(w.wakes.rows().find((r) => r.dedupeKey === 'h2').id);
  });

  it('only one worker turns an agent\'s wakes into a run at a time', async () => {
    const w = world();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    w.redis.store.set(`always-on:lock:${AGENT}`, 'someone-else');
    expect(await w.service.process(AGENT, ORG)).toBe('busy');
    expect(w.startRun).not.toHaveBeenCalled();
    // It looks again shortly.
    expect(w.queue.added.filter((j) => j.name === ALWAYS_ON_WAKE_JOB).some((j) => j.opts.delay > 0)).toBe(true);
  });

  it('pauses itself when it wakes more often in an hour than it may', async () => {
    const w = world({ plan: 'free' }); // 6 an hour
    for (let i = 0; i < 6; i++) {
      w.wakes.seed({ agentId: AGENT, organizationId: ORG, source: 'timer', summary: 't', dedupeKey: `old${i}`, status: 'consumed', runId: `old-run-${i}`, consumedAt: new Date(Date.now() - 60_000), createdAt: new Date() });
    }
    await w.service.reconcileTimer(w.agents.row(AGENT) as any);
    await w.service.wake(AGENT, ORG, 'webhook', { summary: 'again', dedupeKey: 'loop' });

    expect(await w.service.process(AGENT, ORG)).toBe('paused');
    expect(w.startRun).not.toHaveBeenCalled();
    const saved = w.agents.row(AGENT)!.alwaysOn;
    expect(saved.enabled).toBe(false);
    expect(saved.pausedReason.code).toBe('WAKE_LOOP');
    expect(w.queue.repeatable.filter((j) => j.name === ALWAYS_ON_TICK_JOB)).toHaveLength(0);
    expect(w.notified.some((n) => n.type === 'agent.paused' && n.userIds[0] === OWNER)).toBe(true);
    expect(queued(w)).toHaveLength(0);
  });

  it('judges the owner at wake time: one who can no longer run it pauses it, and nothing runs', async () => {
    const w = world({ agent: alwaysOnAgent({ visibility: 'team', teamId: 'team-1' }) });
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    expect(await w.service.process(AGENT, ORG)).toBe('paused');
    expect(w.startRun).not.toHaveBeenCalled();
    expect(w.agents.row(AGENT)!.alwaysOn.pausedReason.code).toBe('OWNER_CANNOT_RUN');
  });

  it('drops the wakes of an agent that was switched off', async () => {
    const w = world();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    await w.agents.update({ id: AGENT }, { alwaysOn: { ...w.agents.row(AGENT)!.alwaysOn, enabled: false } });
    expect(await w.service.process(AGENT, ORG)).toBe('off');
    expect(w.wakes.rows()[0].status).toBe('dropped');
  });

  it('answers the owner on their own channel when the run waiting for them gets their message', async () => {
    const w = world();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    await w.service.process(AGENT, ORG);
    await w.runs.update({ id: 'run-1' }, { status: AgentRunStatus.WAITING_INPUT });
    await w.service.wake(AGENT, ORG, 'channel', {
      summary: 'your owner wrote on Support Slack',
      dedupeKey: 'owner:1',
      ownerMessage: { text: 'Yes, go ahead.', replyTo: { kind: 'channel', channelId: SLACK, to: 'U-OWNER' } },
    });
    expect(await w.service.process(AGENT, ORG)).toBe('live');
    expect(w.sendInput).toHaveBeenCalledWith('run-1', ORG, 'Yes, go ahead.');
    expect(w.runs.row('run-1')!.metadata.replyTo).toEqual([{ kind: 'channel', channelId: SLACK, to: 'U-OWNER' }]);
  });
});

describe('Always on: channel messages', () => {
  const base = { organizationId: ORG, agentId: AGENT, text: 'Where is my refund?', deliveryId: 'd1' };

  it('a webhook delivery on a channel it wakes on becomes a wake and nothing else', async () => {
    const w = world();
    const routed = await w.service.routeInbound({ ...base, gatewayId: GW_HOOK, senderId: 'github', text: '{"action":"opened"}' });
    expect(routed).toBe('consumed');
    const [wake] = w.wakes.rows();
    expect(wake.source).toBe('webhook');
    expect(wake.summary).toContain('opened');
  });

  it('the owner on their own channel joins the standing thread, and the reply goes back to them', async () => {
    const w = world();
    const routed = await w.service.routeInbound({ ...base, gatewayId: GW_SLACK, senderId: 'u-owner', text: 'Check the queue please' });
    expect(routed).toBe('consumed');
    const [wake] = w.wakes.rows();
    expect(wake.payload.ownerMessage.text).toBe('Check the queue please');
    expect(wake.payload.ownerMessage.replyTo).toMatchObject({ channelId: SLACK, to: 'U-OWNER' });
  });

  it('a visitor keeps their own chat; the agent gets one line, never their words', async () => {
    const w = world();
    const routed = await w.service.routeInbound({ ...base, gatewayId: GW_SLACK, senderId: 'U-VISITOR', senderName: 'Ana', text: 'my card number is 5577' });
    expect(routed).toBe('continue');
    const [wake] = w.wakes.rows();
    expect(wake.summary).toBe('Ana wrote on Support Slack (they have their own chat; you do not see it here)');
    expect(JSON.stringify(wake)).not.toContain('5577');
    expect(wake.payload).toBeNull();
  });

  it('a message the agent\'s own bot sent wakes nothing', async () => {
    const w = world();
    expect(await w.service.routeInbound({ ...base, gatewayId: GW_SLACK, senderId: 'B-BOT', text: 'Report: done', fromBot: true })).toBe('continue');
    expect(w.wakes.rows()).toHaveLength(0);
  });

  it('a channel it does not wake on is left alone', async () => {
    const w = world({ agent: alwaysOnAgent({}, { wakeOn: { timer: { everyMinutes: 30 }, channelIds: [] }, ownerChannel: null }) });
    expect(await w.service.routeInbound({ ...base, gatewayId: GW_SLACK, senderId: 'U-VISITOR', text: 'hi' })).toBe('continue');
    expect(w.wakes.rows()).toHaveLength(0);
  });

  it('matches an email owner inside "Name <address>"', () => {
    expect(sameAddress('Frane <Frane@Example.com>', 'frane@example.com')).toBe(true);
    expect(sameAddress('someone@example.com', 'frane@example.com')).toBe(false);
  });
});

describe('Always on: reporting', () => {
  it('answers the owner where they wrote and reports only when it did something', async () => {
    const w = world({ agent: alwaysOnAgent({}, { reportTo: { kind: 'channel', channelId: SLACK, to: 'C-REPORTS' }, report: 'when_acted' }) });
    await w.service.wake(AGENT, ORG, 'channel', {
      summary: 'your owner wrote',
      dedupeKey: 'o1',
      ownerMessage: { text: 'status?', replyTo: { kind: 'channel', channelId: SLACK, to: 'U-OWNER' } },
    });
    await w.service.process(AGENT, ORG);
    // Looked things up only.
    await finishRun(w, 'run-1', { output: 'All quiet.', steps: [{ type: 'tool_call', input: { toolId: TOOL_READ } }] });
    await w.service.onRunFinished('run-1');
    expect(w.posted.map((p) => p.delivery.to)).toEqual(['U-OWNER']);
    expect(w.notified.filter((n) => n.type === 'agent.report')).toHaveLength(0);

    // Did something: the report goes out too.
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't2' });
    await w.service.process(AGENT, ORG);
    await finishRun(w, 'run-2', { output: 'Refunded order 12.', steps: [{ type: 'tool_call', input: { toolId: TOOL_WRITE } }] });
    await w.service.onRunFinished('run-2');
    expect(w.posted.map((p) => p.delivery.to)).toEqual(['U-OWNER', 'C-REPORTS']);
    expect(w.notified.some((n) => n.type === 'agent.report' && n.body.includes('Refunded'))).toBe(true);
  });

  it('reports once however often the run is finished', async () => {
    const w = world({ agent: alwaysOnAgent({}, { reportTo: { kind: 'channel', channelId: SLACK, to: 'C-REPORTS' }, report: 'every_wake' }) });
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    await w.service.process(AGENT, ORG);
    await finishRun(w, 'run-1');
    await w.service.onRunFinished('run-1');
    await w.service.onRunFinished('run-1');
    expect(w.posted).toHaveLength(1);
  });

  it('looks at the inbox again when the run ends', async () => {
    const w = world();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    await w.service.process(AGENT, ORG);
    await w.service.wake(AGENT, ORG, 'manual', { summary: 'now', dedupeKey: 'm1' });
    w.queue.added.length = 0;
    await finishRun(w, 'run-1');
    await w.service.onRunFinished('run-1');
    expect(w.queue.added.some((j) => j.name === ALWAYS_ON_WAKE_JOB)).toBe(true);
  });

  it('says where reports go when a proposal waits for the owner', async () => {
    const w = world({ agent: alwaysOnAgent({}, { reportTo: { kind: 'channel', channelId: SLACK, to: 'C-REPORTS' } }) });
    await w.service.onModuleInit();
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: 't1' });
    await w.service.process(AGENT, ORG);
    w.approvals.emit('approval.requested', { id: 'ap-1', runId: 'run-1', reason: 'Ask before “issue_refund”', organizationId: ORG });
    await new Promise((r) => setTimeout(r, 10));
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].text).toContain('waiting for your OK');
    // The notice is recorded on the run the way a post is, and the run keeps what it carries.
    expect(w.runs.row('run-1')!.metadata).toMatchObject({ triggerType: 'always_on', channelDelivery: { status: 'delivered' } });
    w.service.onModuleDestroy();
  });
});

describe('Always on: the timer', () => {
  it('is put back at boot for every always-on agent, and old heartbeat jobs are removed', async () => {
    const w = world({ plan: 'free', agent: alwaysOnAgent({}, { wakeOn: { timer: { everyMinutes: 5 } } }) });
    w.queue.repeatable.push({ key: 'old-hb', name: LEGACY_HEARTBEAT_JOB, id: `heartbeat-${AGENT}`, every: 300_000, next: 0 });
    w.queue.repeatable.push({ key: 'sched', name: 'execute-agent', id: `schedule-${AGENT}`, every: 60_000, next: 0 });

    const result = await w.service.restoreTimers();

    expect(result.restored).toBe(1);
    const names = w.queue.repeatable.map((j) => j.name);
    expect(names).not.toContain(LEGACY_HEARTBEAT_JOB);
    // A schedule on the same queue is not touched.
    expect(names).toContain('execute-agent');
    const timer = w.queue.repeatable.find((j) => j.name === ALWAYS_ON_TICK_JOB)!;
    // Asked for 5 minutes; the free plan's floor is 15.
    expect(timer.every).toBe(15 * 60_000);
  });

  it('is not restored for an agent that is off or inactive', async () => {
    const w = world({ agent: alwaysOnAgent({ status: 'inactive' }) });
    expect((await w.service.restoreTimers()).restored).toBe(0);
  });
});

describe('Always on: settings', () => {
  it('refuses a timer under the plan\'s floor, and says the floor', async () => {
    const w = world({ plan: 'free' });
    await expect(w.service.configure(AGENT, ORG, { wakeOn: { timer: { everyMinutes: 5 } } })).rejects.toThrow(/every 15 minutes at most/);
    const paid = world({ plan: 'pro' });
    await expect(paid.service.configure(AGENT, ORG, { wakeOn: { timer: { everyMinutes: 5 } } })).resolves.toBeTruthy();
  });

  it('refuses channels and tools that are not the agent\'s', async () => {
    const w = world();
    await expect(w.service.configure(AGENT, ORG, { wakeOn: { channelIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] } })).rejects.toThrow(/own channels/);
    await expect(w.service.configure(AGENT, ORG, { actMode: 'act', askFirstToolIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] })).rejects.toThrow(/tools this agent has/);
  });

  it('refuses to turn on for an agent that is not active', async () => {
    const w = world({ agent: alwaysOnAgent({ status: 'draft' }, { enabled: false }) });
    await expect(w.service.configure(AGENT, ORG, { enabled: true })).rejects.toThrow(/Activate this agent/);
  });

  it('turning it on starts the timer and clears a pause; turning it off stops it', async () => {
    const w = world({ agent: alwaysOnAgent({}, { enabled: false, pausedReason: { code: 'WAKE_LOOP', message: 'x', detectedAt: 'y' } }) });
    const on = await w.service.configure(AGENT, ORG, { enabled: true }, OWNER);
    expect(on.alwaysOn!.pausedReason).toBeNull();
    expect(w.queue.repeatable.filter((j) => j.name === ALWAYS_ON_TICK_JOB)).toHaveLength(1);
    expect(w.audited.some((a) => a.action === 'always_on_enable')).toBe(true);
    await w.service.configure(AGENT, ORG, { enabled: false }, OWNER);
    expect(w.queue.repeatable.filter((j) => j.name === ALWAYS_ON_TICK_JOB)).toHaveLength(0);
  });

  it('suggests asking first before every tool that is not read-only', async () => {
    const w = world();
    const tools = await w.service.suggestedAskFirst(AGENT, ORG);
    expect(tools.filter((t) => !t.readOnly).map((t) => t.id)).toEqual([TOOL_WRITE]);
  });
});

describe('Always on: connection events', () => {
  it('wakes the agents granted the connection that asked for that event', async () => {
    const w = world();
    w.grants.seed({ connectionId: 'conn-1', organizationId: ORG, principalType: 'agent', principalId: AGENT, expiresAt: null });
    expect(await w.service.onConnectionEvent({ organizationId: ORG, connectionId: 'conn-1', name: 'Stripe', event: 'expiring' })).toBe(1);
    expect(w.wakes.rows()[0].summary).toBe('the connection "Stripe" is about to expire');
    // The same event on the same day is one wake.
    expect(await w.service.onConnectionEvent({ organizationId: ORG, connectionId: 'conn-1', name: 'Stripe', event: 'expiring' })).toBe(0);
    // An event it did not ask for wakes nothing.
    expect(await w.service.onConnectionEvent({ organizationId: ORG, connectionId: 'conn-1', name: 'Stripe', event: 'expired' })).toBe(0);
  });

  it('wakes nobody for a connection the agent holds no grant on', async () => {
    const w = world();
    expect(await w.service.onConnectionEvent({ organizationId: ORG, connectionId: 'conn-9', event: 'expiring' })).toBe(0);
  });
});
