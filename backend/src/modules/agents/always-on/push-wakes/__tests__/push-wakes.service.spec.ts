import { createHmac } from 'crypto';

import { PUSH_WAKE_CHANGES_JOB, PUSH_WAKE_RENEW_JOB, flattenArgs, nextRenewAt, pushWakeUrl } from '../push-wakes.service';
import { PUSH_WAKE_PRESETS } from '../push-wake-presets';
import { mergeAlwaysOn, defaultAlwaysOn } from '../../always-on.types';
import { wakeMessage } from '../../always-on.service';
import { AGENT, API, OTHER_API, ORG, OWNER, Handler, fakeIssuer, pushWorld } from './push-wakes.harness';
import { alwaysOnAgent } from '../../__tests__/always-on.harness';

/**
 * Push wakes end to end against services that live in memory: a generic
 * one ("Acme", a custom spec with HMAC), and Google Calendar and Gmail
 * driven only by the preset data. Every call the service makes goes
 * through the tool executor; nothing reaches a network.
 */

// ---------------------------------------------------------------------------
// A generic service: hooks with an expiry, a change feed with a cursor.
// ---------------------------------------------------------------------------

function acme() {
  const state = {
    hooks: new Map<string, string>(),
    changes: [] as Array<{ id: string; title: string; body: string }>,
    tooOld: false,
    seq: 0,
  };
  const handlers: Record<string, Handler> = {
    'acme.hooks.create': (p) => {
      const id = `h-${++state.seq}`;
      state.hooks.set(id, p.url);
      return { status: 201, data: { hook: { id }, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), cursor: `c${state.changes.length}` } };
    },
    'acme.hooks.delete': (p) => (state.hooks.delete(p.hookId) ? { status: 204 } : { status: 404 }),
    'acme.changes.list': (p) => {
      if (state.tooOld && p.since) return { status: 410, error: 'cursor too old' };
      const since = p.since ? Number(String(p.since).slice(1)) : state.changes.length;
      const start = p.page ? Number(p.page) : since;
      const slice = state.changes.slice(start, start + 2);
      const next = start + 2 < state.changes.length ? String(start + 2) : undefined;
      return { data: { changes: slice, ...(next ? { nextPage: next } : {}), cursor: `c${Math.min(start + 2, state.changes.length)}` } };
    },
  };
  return { state, handlers };
}

const ACME_SPEC = {
  verification: { method: 'hmac', headerName: 'X-Acme-Signature', algorithm: 'sha256', encoding: 'hex', signedContent: '{{body}}' },
  subscribe: {
    operation: 'acme.hooks.create',
    arguments: { body: { url: '{{endpoint.url}}' } },
    expiresAtPath: 'expiresAt',
    keep: { hookId: 'hook.id' },
    cursorPath: 'cursor',
  },
  renew: { everyMinutes: 60, stopPrevious: true },
  stop: { operation: 'acme.hooks.delete', arguments: { path: { hookId: '{{state.subscription.hookId}}' } } },
  changes: {
    operation: 'acme.changes.list',
    arguments: { query: { since: '{{state.cursor}}', page: '{{page}}' } },
    nextPagePath: 'nextPage',
    maxPages: 5,
    itemsPath: 'changes[*]',
    cursorPath: 'cursor',
    resetOnStatus: [410],
    prime: { operation: 'acme.changes.list', arguments: { query: {} }, cursorPath: 'cursor' },
    item: { id: 'id', title: 'title' },
  },
  summary: '{{count}} change(s) at Acme, latest "{{last.title}}"',
};

const signed = (key: string, body: string) => ({
  headers: { 'x-acme-signature': createHmac('sha256', key).update(body).digest('hex'), 'content-type': 'application/json' },
  rawBody: body,
});

describe('push wakes: a generic service described as data', () => {
  async function setUp() {
    const a = acme();
    const w = pushWorld(a.handlers);
    const view = await w.service.create(AGENT, ORG, { apiId: API, name: 'Acme', spec: ACME_SPEC, secret: 'acme-key', debounceSeconds: 15 }, OWNER);
    return { a, w, view };
  }

  it('subscribes with the connection\'s own tool, keeps the hook, and keeps the key out of the row', async () => {
    const { a, w, view } = await setUp();
    expect(w.calls[0]).toMatchObject({ operation: 'acme.hooks.create', params: { url: pushWakeUrl(view.subscriptionId) } });
    // Run as the agent's owner, the same principal an always-on run uses.
    expect(w.calls[0].options.principal).toMatchObject({ kind: 'user', userId: OWNER });
    expect([...a.state.hooks.values()]).toEqual([pushWakeUrl(view.subscriptionId)]);
    const row = w.subs.row(view.subscriptionId);
    expect(row.state).toEqual({ subscription: { hookId: 'h-1' }, cursor: 'c0' });
    expect(row.health).toBe('valid');
    expect(row.renewAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    // The key is a managed credential; nothing on the row holds it.
    expect(JSON.stringify(row)).not.toContain('acme-key');
    expect(w.credentials.rows.get(row.verifyCredentialId)?.config).toEqual({ secret: 'acme-key' });
    expect(view.health.status).toBe('valid');
  });

  it('refuses a connection that lacks an operation the spec calls', async () => {
    const a = acme();
    const w = pushWorld(a.handlers);
    await expect(w.service.create(AGENT, ORG, { apiId: OTHER_API, spec: ACME_SPEC, secret: 'k' }, OWNER)).rejects.toThrow(/no active tool for acme\.hooks\.create/);
    await expect(w.service.create(AGENT, ORG, { apiId: API, spec: ACME_SPEC }, OWNER)).rejects.toThrow(/signing key/);
    expect(w.subs.rows()).toHaveLength(0);
  });

  it('verifies each push, and many pushes in the window queue one read', async () => {
    const { w, view } = await setUp();
    expect(await w.service.receive(view.subscriptionId, signed('wrong-key', '{}'))).toBe('rejected');
    expect(w.subs.row(view.subscriptionId).health).toBe('failed');
    expect(w.queue.added).toHaveLength(0);

    for (let i = 0; i < 5; i++) expect(await w.service.receive(view.subscriptionId, signed('acme-key', `{"n":${i}}`))).toBe('accepted');
    const jobs = w.queue.added.filter((j) => j.name === PUSH_WAKE_CHANGES_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].opts.delay).toBe(15_000);
    expect(w.subs.row(view.subscriptionId).pushCount).toBe(5);
    expect(await w.service.receive('00000000-0000-4000-8000-000000000000', signed('acme-key', '{}'))).toBe('unknown');
  });

  it('reads what changed from the cursor and wakes the agent with ids and titles, not bodies', async () => {
    const { a, w, view } = await setUp();
    a.state.changes.push(
      { id: 'x1', title: 'Order 7 refunded', body: 'PRIVATE BODY 1' },
      { id: 'x2', title: 'Order 8 opened', body: 'PRIVATE BODY 2' },
      { id: 'x3', title: 'Order 9 shipped', body: 'PRIVATE BODY 3' },
    );
    await w.service.receive(view.subscriptionId, signed('acme-key', '{}'));
    await w.service.receive(view.subscriptionId, signed('acme-key', '{}'));
    expect(await w.service.processPushes(view.subscriptionId)).toBe('woke');

    // Three pages' worth read from c0, across two pages.
    expect(w.calls.filter((c) => c.operation === 'acme.changes.list').map((c) => c.params)).toEqual([{ since: 'c0' }, { since: 'c0', page: '2' }]);
    const wakes = w.alwaysOn.wakes.rows();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ source: 'push', sourceRef: view.id, summary: '3 change(s) at Acme, latest "Order 9 shipped"' });
    expect(wakes[0].payload).toEqual({
      pushWakeId: view.id,
      name: 'Acme',
      pushes: 2,
      changes: [
        { id: 'x1', title: 'Order 7 refunded' },
        { id: 'x2', title: 'Order 8 opened' },
        { id: 'x3', title: 'Order 9 shipped' },
      ],
    });
    expect(JSON.stringify(wakes[0])).not.toContain('PRIVATE BODY');
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe('c3');
    expect(w.members.row(view.id).lastWakeAt).toBeInstanceOf(Date);
    // The agent reads what changed under the wake's line.
    expect(wakeMessage('brief', wakes as any)).toContain('What changed:\n  - id: x1, title: Order 7 refunded');
    // The wake asked the agent to look (the always-on wake job).
    expect(w.alwaysOn.queue.added.some((j) => j.name === 'always-on-wake')).toBe(true);
    // A new window opens after the read.
    expect(w.redis.store.has(`push-wake:pending:${view.subscriptionId}`)).toBe(false);
  });

  it('nothing new is no wake; the same change read twice is one wake', async () => {
    const { a, w, view } = await setUp();
    expect(await w.service.processPushes(view.subscriptionId)).toBe('quiet');
    expect(w.alwaysOn.wakes.rows()).toHaveLength(0);

    a.state.changes.push({ id: 'x1', title: 'One', body: '' });
    expect(await w.service.processPushes(view.subscriptionId)).toBe('woke');
    // A retried job that read from the old cursor again (it failed after the wake) wakes nobody twice.
    await w.subs.update({ id: view.subscriptionId }, { state: { subscription: { hookId: 'h-1' }, cursor: 'c0' } });
    expect(await w.service.processPushes(view.subscriptionId)).toBe('quiet');
    expect(w.alwaysOn.wakes.rows()).toHaveLength(1);
  });

  it('a cursor that is too old starts again, and the agent is told it could not tell what changed', async () => {
    const { a, w, view } = await setUp();
    a.state.changes.push({ id: 'x1', title: 'One', body: '' });
    a.state.tooOld = true;
    expect(await w.service.processPushes(view.subscriptionId)).toBe('woke');
    expect(w.alwaysOn.wakes.rows()[0].summary).toMatch(/Acme: something changed \(it could not tell what: its starting point was too old/);
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe('c1');
  });

  it('an agent that is off is not woken, and its cursor stays', async () => {
    const { a, w, view } = await setUp();
    const agent = w.alwaysOn.agents.row(AGENT);
    await w.alwaysOn.agents.update({ id: AGENT }, { alwaysOn: { ...agent.alwaysOn, enabled: false } });
    a.state.changes.push({ id: 'x1', title: 'One', body: '' });
    expect(await w.service.processPushes(view.subscriptionId)).toBe('off');
    expect(w.alwaysOn.wakes.rows()).toHaveLength(0);
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe('c0');
    // ...and the renewal sweep leaves it alone until it is on again.
    expect(await w.service.renewDue(new Date(Date.now() + 2 * 3_600_000))).toEqual({ renewed: 0, failed: 0, skipped: 1 });
  });

  it('renews when due, stopping the subscription it replaces', async () => {
    const { a, w, view } = await setUp();
    expect(await w.service.renewDue(new Date())).toEqual({ renewed: 0, failed: 0, skipped: 0 });
    const out = await w.service.renewDue(new Date(Date.now() + 61 * 60_000));
    expect(out).toEqual({ renewed: 1, failed: 0, skipped: 0 });
    expect([...a.state.hooks.keys()]).toEqual(['h-2']);
    expect(w.calls.find((c) => c.operation === 'acme.hooks.delete')?.params).toEqual({ hookId: 'h-1' });
    expect(w.subs.row(view.subscriptionId).state).toEqual({ subscription: { hookId: 'h-2' }, cursor: 'c0' });
  });

  it('a failed renewal shows on the wake source and is tried again at the next sweep', async () => {
    const { a, w, view } = await setUp();
    a.handlers['acme.hooks.create'] = () => ({ status: 403, error: 'HTTP 403: forbidden' });
    const later = new Date(Date.now() + 61 * 60_000);
    expect(await w.service.renewDue(later)).toEqual({ renewed: 0, failed: 1, skipped: 0 });
    const row = w.subs.row(view.subscriptionId);
    expect(row.health).toBe('failed');
    expect(row.lastError).toMatch(/Subscribing \(acme\.hooks\.create\) failed: HTTP 403/);
    // renewAt was not moved, so the next sweep tries again.
    expect(row.renewAt.getTime()).toBeLessThanOrEqual(later.getTime());
  });

  it('removing it stops the hook, drops the key, and deletes the row', async () => {
    const { a, w, view } = await setUp();
    const credentialId = w.subs.row(view.subscriptionId).verifyCredentialId;
    expect(await w.service.remove(view.id, AGENT, ORG)).toEqual({ stopped: true, error: null, shared: false });
    expect(a.state.hooks.size).toBe(0);
    expect(w.credentials.rows.has(credentialId)).toBe(false);
    expect(w.subs.rows()).toHaveLength(0);
  });

  it('the renewal sweep is scheduled at boot, every PUSH_WAKE_RENEW_SWEEP_MINUTES', async () => {
    const w = pushWorld(acme().handlers);
    const before = process.env.PUSH_WAKE_RENEW_SWEEP_MINUTES;
    process.env.PUSH_WAKE_RENEW_SWEEP_MINUTES = '7';
    try {
      await w.service.onModuleInit();
    } finally {
      if (before === undefined) delete process.env.PUSH_WAKE_RENEW_SWEEP_MINUTES;
      else process.env.PUSH_WAKE_RENEW_SWEEP_MINUTES = before;
    }
    expect(w.queue.added).toEqual([expect.objectContaining({ name: PUSH_WAKE_RENEW_JOB, opts: expect.objectContaining({ repeat: { every: 7 * 60_000 } }) })]);
  });
});

describe('push wakes: arguments reach the tool flat', () => {
  it('merges the path, query, header and body groups into what an imported tool takes', () => {
    expect(flattenArgs({ path: { calendarId: 'primary' }, query: { syncToken: 's1' }, body: { id: 'c', type: 'web_hook' } })).toEqual({ calendarId: 'primary', syncToken: 's1', id: 'c', type: 'web_hook' });
    expect(flattenArgs({ userId: 'me' })).toEqual({ userId: 'me' });
    expect(flattenArgs(null)).toEqual({});
  });
});

describe('push wakes: when to renew', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  it('takes the earlier of "every N minutes" and "N minutes before it ends"', () => {
    const ends = new Date('2026-10-29T10:00:00Z');
    expect(nextRenewAt({ everyMinutes: 1440 }, now, ends)?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    expect(nextRenewAt({ beforeExpiryMinutes: 180 }, now, ends)?.toISOString()).toBe('2026-10-29T07:00:00.000Z');
    expect(nextRenewAt({ everyMinutes: 1440, beforeExpiryMinutes: 180 }, now, new Date('2026-10-22T12:00:00Z'))?.toISOString()).toBe('2026-10-22T11:00:00.000Z');
    expect(nextRenewAt(null, now, ends)).toBeNull();
  });
});

describe('push wakes count as something that wakes it', () => {
  it('Always on turns on with only push wakes', () => {
    const input = { enabled: true, brief: 'Watch my calendar.', wakeOn: { timer: null, channelIds: [], connectionEvents: [] } };
    expect(() => mergeAlwaysOn(defaultAlwaysOn(), input)).toThrow(/at least one thing that wakes it/);
    expect(mergeAlwaysOn(defaultAlwaysOn(), input, { pushWakes: 1 }).enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Google Calendar, from the preset data alone.
// ---------------------------------------------------------------------------

function fakeCalendar() {
  const state = {
    version: 1,
    events: new Map<string, { id: string; summary: string; status: string; start: { dateTime: string }; description: string; v: number }>(),
    channels: new Map<string, { token: string; address: string; resourceId: string }>(),
    expired: new Set<string>(),
  };
  state.events.set('e0', { id: 'e0', summary: 'Old standup', status: 'confirmed', start: { dateTime: '2026-10-20T09:00:00Z' }, description: 'notes', v: 1 });
  const handlers: Record<string, Handler> = {
    'calendar.events.watch': (p) => {
      if (p.calendarId !== 'primary') return { status: 404 };
      const { id, type, address, token } = p;
      if (type !== 'web_hook' || !id || !address?.startsWith('http')) return { status: 400 };
      state.channels.set(id, { token, address, resourceId: 'res-primary' });
      return { data: { kind: 'api#channel', id, resourceId: 'res-primary', resourceUri: 'https://www.googleapis.com/calendar/v3/calendars/primary/events', token, expiration: String(Date.now() + 7 * 86_400_000) } };
    },
    'calendar.channels.stop': (p) => (state.channels.delete(p.id) ? { status: 204 } : { status: 404 }),
    'calendar.events.list': (p) => {
      const q = p;
      if (q.syncToken) {
        if (state.expired.has(q.syncToken)) return { status: 410, error: 'HTTP 410: Sync token is no longer valid' };
        const since = Number(String(q.syncToken).slice(1));
        const items = [...state.events.values()].filter((e) => e.v > since);
        return { data: { items, nextSyncToken: `s${state.version}` } };
      }
      // A full list, one event a page, the sync token on the last page.
      const all = [...state.events.values()];
      const at = q.pageToken ? Number(q.pageToken) : 0;
      const last = at + 1 >= all.length;
      return { data: { items: all.slice(at, at + 1), ...(last ? { nextSyncToken: `s${state.version}` } : { nextPageToken: String(at + 1) }) } };
    },
  };
  const change = (id: string, summary: string) => {
    state.version++;
    state.events.set(id, { id, summary, status: 'confirmed', start: { dateTime: '2026-10-23T15:00:00Z' }, description: 'PRIVATE AGENDA', v: state.version });
  };
  return { state, handlers, change };
}

describe('push wakes: the Google Calendar preset', () => {
  async function setUp() {
    const cal = fakeCalendar();
    const w = pushWorld(cal.handlers);
    const view = await w.service.create(AGENT, ORG, { presetKey: 'google_calendar', apiId: API }, OWNER);
    const row = w.subs.row(view.subscriptionId);
    const secret = w.credentials.rows.get(row.verifyCredentialId)!.config.secret as string;
    const headers = (extra: Record<string, string>) => ({
      'x-goog-channel-id': row.state.subscription.id,
      'x-goog-channel-token': secret,
      'x-goog-resource-id': 'res-primary',
      'x-goog-resource-state': 'exists',
      ...extra,
    });
    return { cal, w, view, row, secret, headers };
  }

  it('opens a channel to its own address with a random token, and primes a sync token', async () => {
    const { cal, w, view, row, secret } = await setUp();
    const watch = w.calls.find((c) => c.operation === 'calendar.events.watch')!;
    expect(watch.params).toEqual({ calendarId: 'primary', id: expect.any(String), type: 'web_hook', address: pushWakeUrl(view.subscriptionId), token: secret });
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(cal.state.channels.get(watch.params.id)?.token).toBe(secret);
    expect(row.state).toEqual({ subscription: { id: watch.params.id, resourceId: 'res-primary' }, cursor: 's1' });
    // Renewed three hours before Google closes the channel.
    expect(row.renewAt.getTime()).toBe(row.subscriptionExpiresAt.getTime() - 180 * 60_000);
    expect(view.setup.some((s) => s.command === pushWakeUrl(view.subscriptionId))).toBe(true);
  });

  it('checks the token and the channel, ignores the opening sync, and acknowledges a replaced channel', async () => {
    const { w, view, headers } = await setUp();
    expect(await w.service.receive(view.subscriptionId, { headers: headers({ 'x-goog-resource-state': 'sync' }), rawBody: '' })).toBe('ignored');
    expect(await w.service.receive(view.subscriptionId, { headers: headers({ 'x-goog-channel-token': 'guess' }), rawBody: '' })).toBe('rejected');
    expect(await w.service.receive(view.subscriptionId, { headers: headers({ 'x-goog-channel-id': 'an-old-channel' }), rawBody: '' })).toBe('ignored');
    expect(w.queue.added.filter((j) => j.name === PUSH_WAKE_CHANGES_JOB)).toHaveLength(0);
    expect(await w.service.receive(view.subscriptionId, { headers: headers({}), rawBody: '' })).toBe('accepted');
    expect(w.queue.added.filter((j) => j.name === PUSH_WAKE_CHANGES_JOB)).toHaveLength(1);
  });

  it('lists what changed with the sync token and wakes with event id, name and time, never the description', async () => {
    const { cal, w, view, headers } = await setUp();
    cal.change('e1', 'Board meeting');
    cal.change('e2', 'Dentist');
    await w.service.receive(view.subscriptionId, { headers: headers({}), rawBody: '' });
    expect(await w.service.processPushes(view.subscriptionId)).toBe('woke');
    const list = w.calls.filter((c) => c.operation === 'calendar.events.list').pop()!;
    expect(list.params).toEqual({ calendarId: 'primary', syncToken: 's1', showDeleted: true, maxResults: 250 });
    const wake = w.alwaysOn.wakes.rows()[0];
    expect(wake.summary).toBe('2 change(s) in Google Calendar, latest "Dentist"');
    expect(wake.payload.changes).toEqual([
      { id: 'e1', summary: 'Board meeting', status: 'confirmed', start: '2026-10-23T15:00:00Z' },
      { id: 'e2', summary: 'Dentist', status: 'confirmed', start: '2026-10-23T15:00:00Z' },
    ]);
    expect(JSON.stringify(wake.payload)).not.toContain('PRIVATE AGENDA');
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe('s3');
  });

  it('a 410 starts the sync again', async () => {
    const { cal, w, view } = await setUp();
    cal.state.expired.add('s1');
    cal.change('e1', 'Board meeting');
    expect(await w.service.processPushes(view.subscriptionId)).toBe('woke');
    expect(w.alwaysOn.wakes.rows()[0].summary).toMatch(/could not tell what/);
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe('s2');
  });

  it('renews with a new channel and stops the old one; removing stops the current one', async () => {
    const { cal, w, view, row } = await setUp();
    const old = row.state.subscription.id;
    expect((await w.service.renewDue(new Date(row.renewAt.getTime() + 1000))).renewed).toBe(1);
    const fresh = w.subs.row(view.subscriptionId).state.subscription.id;
    expect(fresh).not.toBe(old);
    expect(w.calls.find((c) => c.operation === 'calendar.channels.stop')?.params).toEqual({ id: old, resourceId: 'res-primary' });
    expect([...cal.state.channels.keys()]).toEqual([fresh]);
    await w.service.remove(view.id, AGENT, ORG);
    expect(cal.state.channels.size).toBe(0);
  });

  it('offers the preset only on connections with every tool it calls, and never someone else\'s private one', async () => {
    const cal = fakeCalendar();
    const w = pushWorld(cal.handlers);
    w.apis.seed({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', organizationId: ORG, name: 'Private to someone', visibility: 'private', ownerUserId: 'someone-else' });
    const out = await w.service.options(ORG, OWNER);
    expect(out.presets.map((p) => p.key)).toEqual(['google_calendar', 'gmail']);
    expect(out.apis).toEqual([
      { id: API, name: 'The service', presets: ['google_calendar'] },
      { id: OTHER_API, name: 'Something else', presets: [] },
    ]);
  });
  it('deleting the agent stops every subscription it had', async () => {
    const { cal, w } = await setUp();
    expect(await w.service.removeAllFor(AGENT, ORG)).toBe(1);
    expect(cal.state.channels.size).toBe(0);
    expect(w.credentials.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gmail, from the preset data alone, with Pub/Sub's signed push.
// ---------------------------------------------------------------------------

const SA = 'almyty-push@my-project.iam.gserviceaccount.com';
const TOPIC = 'projects/my-project/topics/almyty-gmail';

function fakeGmail() {
  const state = {
    historyId: 100,
    floor: 0,
    watching: null as null | { topicName: string; labelIds: string[] },
    messages: [] as Array<{ id: string; at: number; from: string; subject: string; body: string }>,
  };
  const handlers: Record<string, Handler> = {
    'gmail.users.watch': (p) => {
      if (p.userId !== 'me' || p.topicName !== TOPIC) return { status: 400, error: 'HTTP 400: Invalid topicName' };
      state.watching = { topicName: p.topicName, labelIds: p.labelIds };
      return { data: { historyId: String(state.historyId), expiration: String(Date.now() + 7 * 86_400_000) } };
    },
    'gmail.users.stop': () => ((state.watching = null), { status: 204 }),
    'gmail.users.getProfile': () => ({ data: { emailAddress: 'me@x.test', historyId: String(state.historyId) } }),
    'gmail.users.history.list': (p) => {
      const start = Number(p.startHistoryId);
      if (start < state.floor) return { status: 404, error: 'HTTP 404: Requested entity was not found.' };
      if (p.historyTypes !== 'messageAdded' || p.labelId !== 'INBOX') return { status: 400 };
      const added = state.messages.filter((m) => m.at > start);
      return {
        data: {
          history: added.map((m) => ({ id: String(m.at), messages: [{ id: m.id }], messagesAdded: [{ message: { id: m.id, threadId: `t-${m.id}`, labelIds: ['INBOX'] } }] })),
          historyId: String(state.historyId),
        },
      };
    },
    'gmail.users.messages.get': (p) => {
      const m = state.messages.find((x) => x.id === p.id);
      if (!m || p.format !== 'metadata') return { status: 404 };
      return {
        data: {
          id: m.id,
          snippet: m.body.slice(0, 40),
          payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: 'Thu, 22 Oct 2026 10:00:00 +0000' }] },
        },
      };
    },
  };
  const arrive = (id: string, from: string, subject: string) => {
    state.historyId += 5;
    state.messages.push({ id, at: state.historyId, from, subject, body: 'PRIVATE MAIL BODY with details' });
  };
  return { state, handlers, arrive };
}

describe('push wakes: the Gmail preset', () => {
  async function setUp() {
    const gmail = fakeGmail();
    const w = pushWorld(gmail.handlers);
    const issuer = await fakeIssuer();
    w.service.keySetFor = issuer.keySetFor;
    const view = await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings: { topicName: TOPIC, pushServiceAccount: SA } }, OWNER);
    const push = async (claims: Record<string, unknown> = {}, opts: { audience?: string; issuer?: string; expiresIn?: number | string; iat?: number } = {}) => {
      const token = await issuer.mint({ email: SA, email_verified: true, sub: '1', ...claims }, { audience: opts.audience ?? pushWakeUrl(view.subscriptionId), ...opts });
      const body = JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'me@x.test', historyId: gmail.state.historyId })).toString('base64'), messageId: '1' }, subscription: 'projects/my-project/subscriptions/almyty-gmail-push' });
      return { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, rawBody: body };
    };
    return { gmail, w, view, push };
  }

  it('starts the watch on the person\'s topic and takes the starting history id from it', async () => {
    const { gmail, w, view } = await setUp();
    expect(gmail.state.watching).toEqual({ topicName: TOPIC, labelIds: ['INBOX'] });
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe('100');
    // No secret of almyty's own: Google signs each push.
    expect(w.subs.row(view.subscriptionId).verifyCredentialId).toBeNull();
    const renewAt = w.subs.row(view.subscriptionId).renewAt.getTime();
    expect(Math.abs(renewAt - (Date.now() + 24 * 3_600_000))).toBeLessThan(60_000);
    // The setup command names this address as endpoint and audience.
    expect(view.setup.find((s) => s.command?.includes('subscriptions create'))?.command).toContain(`--push-auth-token-audience="${pushWakeUrl(view.subscriptionId)}"`);
    expect(view.setup.find((s) => s.command?.includes('subscriptions create'))?.command).toContain(`--push-auth-service-account="${SA}"`);
  });

  it('a wrong topic is saved with the error on it, for the person to fix', async () => {
    const gmail = fakeGmail();
    const w = pushWorld(gmail.handlers);
    const view = await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings: { topicName: 'projects/my-project/topics/other-topic', pushServiceAccount: SA } }, OWNER);
    expect(view.health).toEqual({ status: 'failed', checkedAt: expect.any(String), error: expect.stringContaining('Invalid topicName') });
  });

  it('accepts Google\'s signed push and refuses a wrong audience, issuer, account or an expired token', async () => {
    const { w, view, push } = await setUp();
    expect(await w.service.receive(view.subscriptionId, await push({}, { audience: 'https://elsewhere.test/push' }))).toBe('rejected');
    expect(await w.service.receive(view.subscriptionId, await push({}, { issuer: 'https://evil.test' }))).toBe('rejected');
    expect(await w.service.receive(view.subscriptionId, await push({ email: 'other@p.iam.gserviceaccount.com' }))).toBe('rejected');
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect(await w.service.receive(view.subscriptionId, await push({}, { iat: past, expiresIn: past + 60 }))).toBe('rejected');
    expect(w.subs.row(view.subscriptionId).lastError).toMatch(/expired/);
    expect(await w.service.receive(view.subscriptionId, await push())).toBe('accepted');
  });

  it('wakes with sender and subject of new mail from the history, never the body', async () => {
    const { gmail, w, view, push } = await setUp();
    gmail.arrive('m1', 'Ana <ana@acme.test>', 'Contract draft');
    gmail.arrive('m2', 'Bo <bo@acme.test>', 'Lunch?');
    await w.service.receive(view.subscriptionId, await push());
    expect(await w.service.processPushes(view.subscriptionId)).toBe('woke');
    const wake = w.alwaysOn.wakes.rows()[0];
    expect(wake.summary).toBe('2 new email(s) in Gmail, latest from Bo <bo@acme.test>: "Lunch?"');
    expect(wake.payload.changes).toEqual([
      { id: 'm1', threadId: 't-m1', from: 'Ana <ana@acme.test>', subject: 'Contract draft', date: 'Thu, 22 Oct 2026 10:00:00 +0000' },
      { id: 'm2', threadId: 't-m2', from: 'Bo <bo@acme.test>', subject: 'Lunch?', date: 'Thu, 22 Oct 2026 10:00:00 +0000' },
    ]);
    expect(JSON.stringify(wake)).not.toContain('PRIVATE MAIL BODY');
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe(String(gmail.state.historyId));
  });

  it('a history id that is too old starts again from the profile', async () => {
    const { gmail, w, view } = await setUp();
    gmail.state.floor = 150;
    gmail.arrive('m1', 'Ana', 'Hi');
    expect(await w.service.processPushes(view.subscriptionId)).toBe('woke');
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe(String(gmail.state.historyId));
    expect(w.calls.some((c) => c.operation === 'gmail.users.getProfile')).toBe(true);
  });

  it('renews the watch daily without moving the cursor, and stops it when removed', async () => {
    const { gmail, w, view } = await setUp();
    gmail.arrive('m1', 'Ana', 'Hi');
    expect((await w.service.renewDue(new Date(Date.now() + 25 * 3_600_000))).renewed).toBe(1);
    // A renewal never skips mail that arrived in between.
    expect(w.subs.row(view.subscriptionId).state.cursor).toBe('100');
    await w.service.remove(view.id, AGENT, ORG);
    expect(gmail.state.watching).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One subscription per resource, shared by the agents on it.
// ---------------------------------------------------------------------------

const AGENT2 = 'abababab-abab-4bab-8bab-abababababab';
const AGENT3 = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const STRANGER = 'efefefef-efef-4fef-8fef-efefefefefef';

describe('push wakes: agents on the same connection and resource share one subscription', () => {
  async function gmailWorld() {
    const gmail = fakeGmail();
    const w = pushWorld(gmail.handlers);
    const issuer = await fakeIssuer();
    w.service.keySetFor = issuer.keySetFor;
    w.alwaysOn.agents.seed(alwaysOnAgent({ id: AGENT2, name: 'Second agent' }, { wakeOn: { timer: null, channelIds: [], connectionEvents: [] }, ownerChannel: null }));
    const settings = { topicName: TOPIC, pushServiceAccount: SA };
    const watches = () => w.calls.filter((c) => c.operation === 'gmail.users.watch').length;
    return { gmail, w, issuer, settings, watches };
  }

  it('a second agent on the same mailbox joins the one watch instead of replacing it', async () => {
    const { w, settings, watches } = await gmailWorld();
    const one = await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    const two = await w.service.create(AGENT2, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    expect(watches()).toBe(1);
    expect(two.subscriptionId).toBe(one.subscriptionId);
    expect(two.endpointUrl).toBe(one.endpointUrl);
    expect(two.sharedWith).toBe(1);
    expect((await w.service.list(AGENT, ORG))[0].sharedWith).toBe(1);
    expect(w.subs.rows()).toHaveLength(1);
    expect(w.members.rows().map((m) => m.agentId).sort()).toEqual([AGENT, AGENT2].sort());
    await expect(w.service.create(AGENT2, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER)).rejects.toThrow(/already wakes on it/);
  });

  it('other settings on the same mailbox are refused: the service keeps one watch', async () => {
    const { w, settings, watches } = await gmailWorld();
    await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    await expect(w.service.create(AGENT2, ORG, { presetKey: 'gmail', apiId: API, settings: { ...settings, labelId: 'IMPORTANT' } }, OWNER)).rejects.toThrow(
      /already watched for another agent, with other settings/,
    );
    expect(watches()).toBe(1);
    expect(w.members.rows()).toHaveLength(1);
  });

  it('reads what changed once and wakes every agent on it that is on, each deduped on its own', async () => {
    const { gmail, w, settings } = await gmailWorld();
    const one = await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    const two = await w.service.create(AGENT2, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    gmail.arrive('m1', 'Ana <ana@acme.test>', 'Contract draft');
    expect(await w.service.processPushes(one.subscriptionId)).toBe('woke');
    expect(w.calls.filter((c) => c.operation === 'gmail.users.history.list')).toHaveLength(1);
    const wakes = w.alwaysOn.wakes.rows();
    expect(wakes.map((x) => [x.agentId, x.sourceRef]).sort()).toEqual([[AGENT, one.id], [AGENT2, two.id]].sort());
    expect(wakes.every((x) => x.summary === '1 new email(s) in Gmail, latest from Ana <ana@acme.test>: "Contract draft"')).toBe(true);
    expect(w.members.row(one.id).lastWakeAt).toBeInstanceOf(Date);
    expect(w.members.row(two.id).lastWakeAt).toBeInstanceOf(Date);
    // The same change read again (a retried job) wakes neither a second time.
    await w.subs.update({ id: one.subscriptionId }, { state: { subscription: {}, cursor: '100' } });
    expect(await w.service.processPushes(one.subscriptionId)).toBe('quiet');
    expect(w.alwaysOn.wakes.rows()).toHaveLength(2);
  });

  it('an agent that is off is skipped; the others are still woken', async () => {
    const { gmail, w, settings } = await gmailWorld();
    const one = await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    await w.service.create(AGENT2, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    const first = w.alwaysOn.agents.row(AGENT);
    await w.alwaysOn.agents.update({ id: AGENT }, { alwaysOn: { ...first.alwaysOn, enabled: false } });
    gmail.arrive('m1', 'Ana', 'Hi');
    expect(await w.service.processPushes(one.subscriptionId)).toBe('woke');
    expect(w.alwaysOn.wakes.rows().map((x) => x.agentId)).toEqual([AGENT2]);
    // Read as an agent that is on.
    expect(w.calls.filter((c) => c.operation === 'gmail.users.history.list').pop()!.options.agentId).toBe(AGENT2);
  });

  it('stops the watch only when the last agent leaves', async () => {
    const { gmail, w, settings } = await gmailWorld();
    const one = await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    const two = await w.service.create(AGENT2, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    expect(await w.service.remove(one.id, AGENT, ORG)).toEqual({ stopped: false, error: null, shared: true });
    expect(gmail.state.watching).not.toBeNull();
    expect(w.calls.some((c) => c.operation === 'gmail.users.stop')).toBe(false);
    expect(w.subs.rows()).toHaveLength(1);
    expect((await w.service.list(AGENT2, ORG))[0].sharedWith).toBe(0);
    // Deleting the last agent stops it, as that agent.
    expect(await w.service.removeAllFor(AGENT2, ORG)).toBe(1);
    expect(gmail.state.watching).toBeNull();
    expect(w.calls.find((c) => c.operation === 'gmail.users.stop')?.options.agentId).toBe(AGENT2);
    expect(w.subs.rows()).toHaveLength(0);
    expect(two.subscriptionId).toBe(one.subscriptionId);
  });

  it('renews as an agent that is on, once for everyone', async () => {
    const { w, settings, watches } = await gmailWorld();
    const one = await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    await w.service.create(AGENT2, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    expect((await w.service.renewDue(new Date(Date.now() + 25 * 3_600_000))).renewed).toBe(1);
    expect(watches()).toBe(2);
    expect(w.subs.row(one.subscriptionId).lastRenewedAt).toBeInstanceOf(Date);
  });

  it('an agent whose owner cannot use the connection cannot join it', async () => {
    const { w, settings } = await gmailWorld();
    await w.service.create(AGENT, ORG, { presetKey: 'gmail', apiId: API, settings }, OWNER);
    await w.apis.update({ id: API }, { visibility: 'private', ownerUserId: OWNER });
    w.alwaysOn.agents.seed(alwaysOnAgent({ id: AGENT3, createdBy: STRANGER }, {}));
    w.alwaysOn.membership.member(ORG, STRANGER);
    await expect(w.service.create(AGENT3, ORG, { presetKey: 'gmail', apiId: API, settings }, STRANGER)).rejects.toThrow(/cannot use "The service"/);
    expect(w.members.rows()).toHaveLength(1);
  });

  it('different calendars are different resources: one channel each', async () => {
    const cal = fakeCalendar();
    cal.handlers['calendar.events.watch'] = ((orig) => (p: any) => orig({ ...p, calendarId: 'primary' }))(cal.handlers['calendar.events.watch']);
    const w = pushWorld(cal.handlers);
    w.alwaysOn.agents.seed(alwaysOnAgent({ id: AGENT2 }, {}));
    const one = await w.service.create(AGENT, ORG, { presetKey: 'google_calendar', apiId: API, settings: { calendarId: 'primary' } }, OWNER);
    const two = await w.service.create(AGENT2, ORG, { presetKey: 'google_calendar', apiId: API, settings: { calendarId: 'team@group.calendar.google.com' } }, OWNER);
    const same = await w.service.create(AGENT2, ORG, { presetKey: 'google_calendar', apiId: API, settings: { calendarId: 'primary' } }, OWNER);
    expect(two.subscriptionId).not.toBe(one.subscriptionId);
    expect(same.subscriptionId).toBe(one.subscriptionId);
    expect(w.calls.filter((c) => c.operation === 'calendar.events.watch')).toHaveLength(2);
  });

  it('changing settings moves the agent to the other resource and leaves the shared one running', async () => {
    const cal = fakeCalendar();
    cal.handlers['calendar.events.watch'] = ((orig) => (p: any) => orig({ ...p, calendarId: 'primary' }))(cal.handlers['calendar.events.watch']);
    const w = pushWorld(cal.handlers);
    w.alwaysOn.agents.seed(alwaysOnAgent({ id: AGENT2 }, {}));
    const one = await w.service.create(AGENT, ORG, { presetKey: 'google_calendar', apiId: API, settings: { calendarId: 'primary' } }, OWNER);
    const two = await w.service.create(AGENT2, ORG, { presetKey: 'google_calendar', apiId: API, settings: { calendarId: 'primary' } }, OWNER);
    const moved = await w.service.update(two.id, AGENT2, ORG, { settings: { calendarId: 'team@group.calendar.google.com' } });
    expect(moved.subscriptionId).not.toBe(one.subscriptionId);
    expect(w.calls.some((c) => c.operation === 'calendar.channels.stop')).toBe(false);
    expect(w.subs.rows()).toHaveLength(2);
    expect(w.members.rows()).toHaveLength(2);
  });

  it('a custom service without a subscribe step is never shared: each keeps its own address and key', async () => {
    const w = pushWorld({});
    w.alwaysOn.agents.seed(alwaysOnAgent({ id: AGENT2 }, {}));
    const spec = { verification: { method: 'hmac', headerName: 'x-sig', algorithm: 'sha256', encoding: 'hex', signedContent: '{{body}}' }, summary: 'x' };
    const one = await w.service.create(AGENT, ORG, { spec, secret: 'k1' }, OWNER);
    const two = await w.service.create(AGENT2, ORG, { spec, secret: 'k2' }, OWNER);
    expect(two.subscriptionId).not.toBe(one.subscriptionId);
  });
});

describe('push wake presets are only data', () => {
  it('no Google name appears in the push wake code, only in the presets', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..');
    for (const file of ['push-wakes.service.ts', 'push-wake-verify.ts', 'push-wake-template.ts', 'push-wake.types.ts', 'push-wakes.controller.ts']) {
      const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect({ file, google: /google|gmail|calendar|pubsub/i.test(code) }).toEqual({ file, google: false });
    }
    expect(PUSH_WAKE_PRESETS.map((p) => p.key)).toEqual(['google_calendar', 'gmail']);
  });
});
