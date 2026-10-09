import { BadRequestException } from '@nestjs/common';

import { AgentRunStatus } from '../../../../entities/agent-run.entity';
import { ALWAYS_ON_CAPACITY_JOB, ALWAYS_ON_DIGEST_JOB, ALWAYS_ON_TICK_JOB } from '../always-on.service';
import { ALWAYS_ON_DIGEST_ENV, ALWAYS_ON_DIGEST_SEED, digestCron, digestText, digestTiming, localDay } from '../always-on-digest';
import { mergeAlwaysOn, readAlwaysOn } from '../always-on.types';
import { AGENT, ORG, OWNER, SLACK, TOOL_READ, TOOL_WRITE, alwaysOnAgent, finishRun, world } from './always-on.harness';

const REPORT_TO = { kind: 'channel', channelId: SLACK, to: 'C-REPORTS', label: '#reports' };

/** An agent that reports once a day into #reports. */
const digestAgent = (alwaysOn: Record<string, any> = {}) =>
  alwaysOnAgent({}, { report: 'daily_digest', reportTo: REPORT_TO, wakeOn: { timer: { everyMinutes: 30 }, channelIds: [] }, ...alwaysOn });

describe('Always on daily summary: when it goes out', () => {
  it('takes the agent\'s own time and zone first', () => {
    const t = digestTiming(
      { digest: { time: '7:30', timezone: 'Asia/Tokyo' } },
      { settings: { alwaysOn: { digestTime: '18:00', digestTimezone: 'Europe/Berlin' } } },
      'America/New_York',
      {},
    );
    expect(t).toEqual({ time: '07:30', timezone: 'Asia/Tokyo' });
  });

  it('left alone, it is 09:00 in the owner\'s own time zone, even when the organization\'s data names another zone', () => {
    const org = { settings: { alwaysOn: { digestTimezone: 'Europe/Berlin' } } };
    expect(digestTiming({ digest: null }, org, 'America/New_York', {})).toEqual({ time: '09:00', timezone: 'America/New_York' });
    expect(digestTiming({ digest: null }, { settings: {} }, 'Asia/Tokyo', {})).toEqual({ time: '09:00', timezone: 'Asia/Tokyo' });
    // The agent's own time keeps the owner's zone when it names none.
    expect(digestTiming({ digest: { time: '17:00' } }, org, 'Asia/Tokyo', {})).toEqual({ time: '17:00', timezone: 'Asia/Tokyo' });
  });

  it('without an owner zone, falls back to the organization\'s data, then the install', () => {
    const org = { settings: { alwaysOn: { digestTime: '18:00', digestTimezone: 'Europe/Berlin' } } };
    expect(digestTiming({ digest: null }, org, null, {})).toEqual({ time: '18:00', timezone: 'Europe/Berlin' });
    expect(digestTiming({ digest: null }, org, 'nowhere', {})).toEqual({ time: '18:00', timezone: 'Europe/Berlin' });
    expect(digestTiming(null, null, null, {})).toEqual(ALWAYS_ON_DIGEST_SEED);
  });

  it('the install default is configuration: the environment overrides the seed, a bad value does not', () => {
    const env = { [ALWAYS_ON_DIGEST_ENV]: JSON.stringify({ time: '06:15', timezone: 'Europe/Zagreb' }) };
    expect(digestTiming(null, null, null, env)).toEqual({ time: '06:15', timezone: 'Europe/Zagreb' });
    const bad = { [ALWAYS_ON_DIGEST_ENV]: JSON.stringify({ time: '25:00', timezone: 'Mars/Olympus' }) };
    expect(digestTiming(null, null, null, bad)).toEqual(ALWAYS_ON_DIGEST_SEED);
    expect(digestTiming(null, { settings: { alwaysOn: { digestTime: 'noon' } } }, 'nowhere', { [ALWAYS_ON_DIGEST_ENV]: '{' })).toEqual(
      ALWAYS_ON_DIGEST_SEED,
    );
  });

  it('runs every day at that time: a cron expression, and the day in the zone', () => {
    expect(digestCron('08:05')).toBe('5 8 * * *');
    // 23:30 UTC on the 6th is already the 7th in Tokyo.
    expect(localDay(new Date('2026-10-06T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-07');
    expect(localDay(new Date('2026-10-06T23:30:00Z'), 'UTC')).toBe('2026-10-06');
  });

  it('the setting is checked: a time of day and a zone that exists', () => {
    const on = mergeAlwaysOn(null, { report: 'daily_digest', digest: { time: '8:00', timezone: 'Europe/Berlin' } });
    expect(on.report).toBe('daily_digest');
    expect(on.digest).toEqual({ time: '08:00', timezone: 'Europe/Berlin' });
    expect(() => mergeAlwaysOn(null, { digest: { time: '8 am' } })).toThrow(BadRequestException);
    expect(() => mergeAlwaysOn(null, { digest: { timezone: 'Mars/Olympus' } })).toThrow(/Unknown time zone/);
    expect(() => mergeAlwaysOn(null, { report: 'hourly' as any })).toThrow(/once a day/);
    expect(mergeAlwaysOn(on, { digest: null }).digest).toBeNull();
    // A stored daily_digest reads back as daily_digest.
    expect(readAlwaysOn({ ...on })?.report).toBe('daily_digest');
  });
});

describe('Always on daily summary: the words', () => {
  const urls = { approvalsUrl: 'https://app.test/approvals', agentUrl: 'https://app.test/agents/a/always-on' };

  it('says nothing on a day with nothing in it', () => {
    expect(digestText({ agentName: 'Support agent', wakes: [], runs: [], acted: [], waiting: [], ...urls })).toBeNull();
    // A wake it never acted on (dropped) is not something to report.
    expect(
      digestText({ agentName: 'Support agent', wakes: [{ source: 'channel', status: 'dropped' }], runs: [], acted: [], waiting: [], ...urls }),
    ).toBeNull();
  });

  it('counts what woke it and how its work ended, says what it changed, and links what waits to Approvals', () => {
    const text = digestText({
      agentName: 'Support agent',
      wakes: [
        { source: 'timer', status: 'consumed' },
        { source: 'timer', status: 'consumed' },
        { source: 'timer', status: 'consumed' },
        { source: 'webhook', status: 'consumed' },
      ],
      runs: [{ status: 'completed' }, { status: 'completed' }, { status: 'failed' }],
      acted: [{ name: 'issue_refund', times: 2 }, { name: 'send_email', times: 1 }],
      waiting: ['issue_refund'],
      ...urls,
    })!;
    expect(text).toContain('Support agent, the last 24 hours:');
    expect(text).toContain('It was woken 3 times by its timer and once by a webhook.');
    expect(text).toContain('It worked 3 times: 2 finished and 1 stopped before finishing.');
    expect(text).toContain('It did: issue_refund (twice) and send_email.');
    expect(text).toContain('Waiting for your OK: issue_refund. Approve or reject it in Approvals: https://app.test/approvals');
    expect(text).toContain('More on its page: https://app.test/agents/a/always-on');
  });

  it('says so when it only looked things up', () => {
    const text = digestText({ agentName: 'A', wakes: [{ source: 'manual', status: 'consumed' }], runs: [{ status: 'completed' }], acted: [], waiting: [], ...urls })!;
    expect(text).toContain('It was woken once because you asked.');
    expect(text).toContain('It only looked things up; it changed nothing.');
    expect(text).not.toContain('Approvals');
  });

  it('does not say it only looked things up when none of its work finished', () => {
    const text = digestText({ agentName: 'A', wakes: [{ source: 'manual', status: 'consumed' }], runs: [{ status: 'failed' }], acted: [], waiting: [], ...urls })!;
    expect(text).toContain('It worked once: 1 stopped before finishing.');
    expect(text).not.toContain('only looked things up');
  });
});

describe('Always on daily summary: the service', () => {
  it('left alone, it goes out once a day at 09:00 in the owner\'s zone; choosing another report removes it', async () => {
    const w = world({ agent: digestAgent({ report: 'when_acted' }), ownerZone: 'Europe/Berlin' });
    // The organization's data names another zone; the owner's comes first.
    await w.organizations.update({ id: ORG }, { settings: { alwaysOn: { digestTimezone: 'Asia/Tokyo' } } });
    await w.service.configure(AGENT, ORG, { report: 'daily_digest' });
    const jobs = w.queue.repeatable.filter((j) => j.name === ALWAYS_ON_DIGEST_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: `always-on-digest-${AGENT}`, cron: '0 9 * * *', tz: 'Europe/Berlin' });
    // The timer is unchanged beside it.
    expect(w.queue.repeatable.filter((j) => j.name === ALWAYS_ON_TICK_JOB)).toHaveLength(1);

    const view = await w.service.view(AGENT, ORG);
    expect(view.digest).toEqual({ time: '09:00', timezone: 'Europe/Berlin' });

    await w.service.configure(AGENT, ORG, { report: 'every_wake' });
    expect(w.queue.repeatable.filter((j) => j.name === ALWAYS_ON_DIGEST_JOB)).toHaveLength(0);
  });

  it('the agent\'s own time wins, and turning Always on off removes the summary', async () => {
    const w = world({ agent: digestAgent() });
    await w.service.configure(AGENT, ORG, { digest: { time: '06:00', timezone: 'Asia/Tokyo' } });
    expect(w.queue.repeatable.find((j) => j.name === ALWAYS_ON_DIGEST_JOB)).toMatchObject({ cron: '0 6 * * *', tz: 'Asia/Tokyo' });
    await w.service.configure(AGENT, ORG, { enabled: false });
    expect(w.queue.repeatable.filter((j) => j.name === ALWAYS_ON_DIGEST_JOB)).toHaveLength(0);
  });

  it('a run of a daily-summary agent reports nothing on its own; the owner\'s own answer still goes back', async () => {
    const w = world({ agent: digestAgent() });
    await w.service.wake(AGENT, ORG, 'channel', {
      summary: 'your owner wrote',
      dedupeKey: 'o1',
      ownerMessage: { text: 'Refund NW-1', replyTo: { kind: 'channel', channelId: SLACK, to: 'U-OWNER', label: 'you' } },
    });
    await w.service.process(AGENT, ORG);
    await finishRun(w, 'run-1', { steps: [{ type: 'tool_call', input: { toolId: TOOL_WRITE }, output: { ok: true } }] });
    await w.service.onRunFinished('run-1');
    expect(w.posted.map((p) => p.delivery.to)).toEqual(['U-OWNER']);
    expect(w.notified.filter((n) => n.type === 'agent.report')).toHaveLength(0);
  });

  it('posts one summary of the last 24 hours where the reports go, tells the owner, and only once that day', async () => {
    const w = world({ agent: digestAgent() });
    const now = new Date('2026-10-07T09:00:00Z');
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    w.wakes.seed({ agentId: AGENT, organizationId: ORG, source: 'timer', summary: 't', dedupeKey: 't1', status: 'consumed', runId: 'r1', createdAt: hoursAgo(5) });
    w.wakes.seed({ agentId: AGENT, organizationId: ORG, source: 'webhook', summary: 'h', dedupeKey: 'h1', status: 'consumed', runId: 'r2', createdAt: hoursAgo(3) });
    // Older than a day: not in it.
    w.wakes.seed({ agentId: AGENT, organizationId: ORG, source: 'manual', summary: 'm', dedupeKey: 'm1', status: 'consumed', runId: 'r0', createdAt: hoursAgo(30) });
    w.runs.seed({ id: 'r1', agentId: AGENT, organizationId: ORG, status: AgentRunStatus.COMPLETED, metadata: { triggerType: 'always_on' }, steps: [{ type: 'tool_call', input: { toolId: TOOL_READ }, output: {} }], createdAt: hoursAgo(5) });
    w.runs.seed({ id: 'r2', agentId: AGENT, organizationId: ORG, status: AgentRunStatus.WAITING_APPROVAL, metadata: { triggerType: 'always_on' }, steps: [{ type: 'tool_call', input: { toolId: TOOL_WRITE }, output: { status: 'waiting_approval' } }], createdAt: hoursAgo(3) });
    // A visitor's chat run is not the standing thread's.
    w.runs.seed({ id: 'r3', agentId: AGENT, organizationId: ORG, status: AgentRunStatus.COMPLETED, metadata: { triggerType: 'chat' }, steps: [], createdAt: hoursAgo(2) });
    await w.agents.update({ id: AGENT }, { alwaysOn: { ...w.agents.row(AGENT)!.alwaysOn, liveRunId: 'r2' } });

    expect(await w.service.digest(AGENT, ORG, now)).toBe('posted');
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].delivery).toMatchObject({ channelId: SLACK, to: 'C-REPORTS' });
    const text = w.posted[0].text;
    expect(text).toContain('It was woken once by its timer and once by a webhook.');
    expect(text).toContain('It worked twice: 1 finished and 1 still going.');
    expect(text).toContain('It only looked things up; it changed nothing.');
    expect(text).toMatch(/Waiting for your OK: issue_refund\. Approve or reject it in Approvals: \S+\/approvals/);
    const note = w.notified.find((n) => n.type === 'agent.report');
    expect(note).toMatchObject({ userIds: [OWNER], title: 'Support agent: daily summary', link: `/agents/${AGENT}/always-on` });
    expect(note.body).toBe(text);
    // The email, for an owner who has report emails on, is a summary, not a wake's report.
    expect(note.email).toMatchObject({ template: 'agent.report', params: { digest: true, message: text } });

    // The queue firing again the same day posts nothing more.
    expect(await w.service.digest(AGENT, ORG, new Date(now.getTime() + 60_000))).toBe('already');
    expect(w.posted).toHaveLength(1);
  });

  it('a quiet day sends nothing anywhere', async () => {
    const w = world({ agent: digestAgent() });
    expect(await w.service.digest(AGENT, ORG, new Date())).toBe('quiet');
    expect(w.posted).toHaveLength(0);
    expect(w.notified).toHaveLength(0);
  });

  it('without a channel the summary goes to the owner\'s notifications only', async () => {
    const w = world({ agent: digestAgent({ reportTo: null }) });
    w.wakes.seed({ agentId: AGENT, organizationId: ORG, source: 'timer', summary: 't', dedupeKey: 't1', status: 'consumed', createdAt: new Date() });
    expect(await w.service.digest(AGENT, ORG, new Date(Date.now() + 1000))).toBe('posted');
    expect(w.posted).toHaveLength(0);
    expect(w.notified.map((n) => n.type)).toEqual(['agent.report']);
  });

  it('an agent that no longer wants a summary drops its job instead of posting', async () => {
    const w = world({ agent: digestAgent({ report: 'when_acted' }) });
    w.queue.repeatable.push({ key: 'k', name: ALWAYS_ON_DIGEST_JOB, id: `always-on-digest-${AGENT}`, cron: '0 9 * * *', tz: 'UTC', next: 0, data: {} });
    expect(await w.service.digest(AGENT, ORG)).toBe('off');
    expect(w.queue.repeatable).toHaveLength(0);
  });

  it('boot puts the summary back beside the timer, and the capacity check', async () => {
    const w = world({ agent: digestAgent() });
    await w.service.restoreTimers();
    const names = w.queue.repeatable.map((j) => j.name).sort();
    expect(names).toEqual([ALWAYS_ON_CAPACITY_JOB, ALWAYS_ON_DIGEST_JOB, ALWAYS_ON_TICK_JOB].sort());
    // Restoring twice leaves one of each.
    await w.service.restoreTimers();
    expect(w.queue.repeatable).toHaveLength(3);
  });
});
