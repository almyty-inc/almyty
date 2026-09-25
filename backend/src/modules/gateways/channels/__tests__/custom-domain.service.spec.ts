import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ActiveHolder,
  CustomDomainService,
  CustomDomainStore,
  DOMAIN_DEMOTED_MESSAGE,
  DOMAIN_TAKEN_OVER_MESSAGE,
  DueClaim,
  RECHECK_AFTER_MS,
  TxtResolver,
} from '../custom-domain.service';
import { CustomDomainConfig, RECHECK_FAILURES_BEFORE_DEMOTION, VERIFICATION_VALUE_PREFIX } from '../custom-domain';

/**
 * Custom domains for hosted chat: claim, publish TXT, verify, serve,
 * re-check, hand over.
 *
 * The store double below holds gateway rows and enforces the same rules
 * the Postgres store does: compare-and-set on the claim that was checked,
 * at most one ACTIVE row per hostname across every organization
 * (UQ_gateways_custom_domain_active), and a takeover that demotes and
 * promotes together or not at all. Each call yields a turn before it
 * lands, like a round trip, so interleavings are real. The SQL itself is
 * exercised against a real database in
 * test/integration/custom-domain-store.integration.spec.ts.
 */

interface Row {
  id: string;
  organizationId: string;
  type: string;
  name: string;
  configuration: Record<string, any>;
  customDomain: CustomDomainConfig | null;
  visibility?: 'org' | 'team' | 'private';
  ownerUserId?: string | null;
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const copy = <T>(value: T): T => (value == null ? value : JSON.parse(JSON.stringify(value)));

class MemoryStore implements CustomDomainStore {
  constructor(readonly rows: Map<string, Row>) {}

  private activeOn(hostname: string, exceptGatewayId: string): Row | undefined {
    return [...this.rows.values()].find(
      (r) => r.id !== exceptGatewayId && r.type === 'hosted_chat' && r.customDomain?.status === 'active' && r.customDomain.hostname === hostname,
    );
  }

  /** What the unique index refuses: two active rows on one hostname. */
  private violatesUnique(gatewayId: string, next: CustomDomainConfig): boolean {
    const row = this.rows.get(gatewayId)!;
    return row.type === 'hosted_chat' && next.status === 'active' && !!this.activeOn(next.hostname, gatewayId);
  }

  async write(gatewayId: string, organizationId: string, block: CustomDomainConfig | null) {
    await turn();
    const row = this.rows.get(gatewayId);
    if (!row || row.organizationId !== organizationId) return;
    if (block && this.violatesUnique(gatewayId, block)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    row.customDomain = copy(block);
  }

  async replaceClaim(gatewayId: string, organizationId: string, current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>, next: CustomDomainConfig) {
    await turn();
    const row = this.rows.get(gatewayId);
    const stored = row?.customDomain;
    if (!row || row.organizationId !== organizationId || stored?.hostname !== current.hostname || stored?.verificationToken !== current.verificationToken) {
      return 'stale' as const;
    }
    if (this.violatesUnique(gatewayId, next)) return 'conflict' as const;
    row.customDomain = copy(next);
    return 'ok' as const;
  }

  async activeHolder(hostname: string, exceptGatewayId: string): Promise<ActiveHolder | null> {
    await turn();
    const row = this.activeOn(hostname, exceptGatewayId);
    return row ? { gatewayId: row.id, organizationId: row.organizationId, name: row.name, visibility: row.visibility ?? 'org', ownerUserId: row.ownerUserId ?? null, block: copy(row.customDomain!) } : null;
  }

  async takeOver(
    winner: { gatewayId: string; organizationId: string; current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>; next: CustomDomainConfig },
    holder: { gatewayId: string; current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>; demoted: CustomDomainConfig },
  ) {
    await turn();
    // All or nothing, like the transaction.
    const h = this.rows.get(holder.gatewayId);
    const hb = h?.customDomain;
    if (!h || hb?.status !== 'active' || hb.hostname !== holder.current.hostname || hb.verificationToken !== holder.current.verificationToken) {
      return 'holder_changed' as const;
    }
    const w = this.rows.get(winner.gatewayId);
    const wb = w?.customDomain;
    if (!w || w.organizationId !== winner.organizationId || wb?.hostname !== winner.current.hostname || wb?.verificationToken !== winner.current.verificationToken) {
      return 'stale' as const;
    }
    const before = h.customDomain;
    h.customDomain = copy(holder.demoted);
    if (this.violatesUnique(w.id, winner.next)) {
      h.customDomain = before;
      return 'conflict' as const;
    }
    w.customDomain = copy(winner.next);
    return 'ok' as const;
  }

  async dueForRecheck(checkedBefore: string, limit: number): Promise<DueClaim[]> {
    await turn();
    return [...this.rows.values()]
      .filter((r) => r.type === 'hosted_chat' && r.customDomain?.status === 'active')
      .filter((r) => !r.customDomain!.lastCheckedAt || r.customDomain!.lastCheckedAt < checkedBefore)
      .slice(0, limit)
      .map((r) => ({ gatewayId: r.id, organizationId: r.organizationId, name: r.name, visibility: r.visibility ?? 'org', ownerUserId: r.ownerUserId ?? null, block: copy(r.customDomain!) }));
  }

  async recordRecheck(gatewayId: string, current: Pick<CustomDomainConfig, 'hostname' | 'verificationToken' | 'lastCheckedAt'>, next: CustomDomainConfig) {
    await turn();
    const stored = this.rows.get(gatewayId)?.customDomain;
    if (
      stored?.status !== 'active' ||
      stored.hostname !== current.hostname ||
      stored.verificationToken !== current.verificationToken ||
      (stored.lastCheckedAt ?? null) !== (current.lastCheckedAt ?? null)
    ) {
      return 'stale' as const;
    }
    this.rows.get(gatewayId)!.customDomain = copy(next);
    return 'ok' as const;
  }
}

/** Records what would be sent; the real pipeline is NotificationsService.emit. */
class RecordingNotifications {
  readonly sent: any[] = [];
  async emit(input: any) {
    this.sent.push(input);
  }
}

function harness(opts: { txt?: Record<string, string[]>; resolver?: TxtResolver } = {}) {
  const rows = new Map<string, Row>([
    ['gw-a', { id: 'gw-a', organizationId: 'org-a', type: 'hosted_chat', name: 'Acme chat', configuration: { hostedChat: { slug: 'acme' } }, customDomain: null }],
    ['gw-b', { id: 'gw-b', organizationId: 'org-b', type: 'hosted_chat', name: 'Bravo chat', configuration: { hostedChat: { slug: 'bravo' } }, customDomain: null }],
    ['gw-w', { id: 'gw-w', organizationId: 'org-a', type: 'chat_widget', name: 'Widget', configuration: {}, customDomain: null }],
  ]);
  const store = new MemoryStore(rows);
  const txt = opts.txt ?? {};
  const resolver: TxtResolver =
    opts.resolver ??
    (async (name) => {
      const values = txt[name];
      if (!values) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return values.map((v) => [v]);
    });
  // GatewaysService.findManageable's contract: org-scoped, manage right required.
  const gatewaysService = {
    findManageable: async (id: string, organizationId: string, userId: string) => {
      const row = rows.get(id);
      if (!row || row.organizationId !== organizationId) throw new NotFoundException('Gateway not found');
      if (userId === 'viewer') throw new ForbiddenException('not allowed');
      return copy(row);
    },
  };
  const notifications = new RecordingNotifications();
  const service = new CustomDomainService(gatewaysService as any, store, resolver, notifications as any);
  const publish = (name: string, token: string) => {
    txt[name] = [...(txt[name] ?? []), `${VERIFICATION_VALUE_PREFIX}${token}`];
  };
  const unpublish = (name: string, token: string) => {
    txt[name] = (txt[name] ?? []).filter((v) => v !== `${VERIFICATION_VALUE_PREFIX}${token}`);
    if (txt[name].length === 0) delete txt[name];
  };
  return { service, rows, store, txt, publish, unpublish, notifications };
}

const block = (rows: Map<string, Row>, id: string): CustomDomainConfig => rows.get(id)!.customDomain!;

describe('CustomDomainService', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    delete process.env.HOSTED_CHAT_CUSTOM_DOMAIN_TARGET;
    process.env.HOSTED_CHAT_BASE_DOMAIN = 'almyty.app';
  });
  afterAll(() => {
    process.env = OLD;
  });

  it('claims a hostname unverified and shows the TXT and CNAME records to publish', async () => {
    const { service, rows } = harness();
    const view = await service.set('gw-a', 'org-a', 'u1', ' Chat.Acme.com ');
    expect(view.status).toBe('pending_verification');
    expect(view.records.txt).toEqual({
      type: 'TXT',
      name: '_almyty-verify.chat.acme.com',
      value: `${VERIFICATION_VALUE_PREFIX}${block(rows, 'gw-a').verificationToken}`,
    });
    expect(view.records.cname).toEqual({ type: 'CNAME', name: 'chat.acme.com', value: 'acme.almyty.app' });
    expect(block(rows, 'gw-a').status).toBe('pending_verification');
    // The claim is its own column, never a key in the configuration.
    expect(rows.get('gw-a')!.configuration.customDomain).toBeUndefined();
  });

  it('serves the hostname only once its TXT record proves control', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');

    const notYet = await service.verify('gw-a', 'org-a', 'u1');
    expect(notYet.status).toBe('failed');
    expect(notYet.lastError).toMatch(/No TXT record/);
    expect(block(rows, 'gw-a').status).not.toBe('active');

    publish('_almyty-verify.chat.acme.com', 'not-the-token');
    expect((await service.verify('gw-a', 'org-a', 'u1')).lastError).toMatch(/did not match/);
    expect(block(rows, 'gw-a').status).not.toBe('active');

    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    const live = await service.verify('gw-a', 'org-a', 'u1');
    expect(live.status).toBe('active');
    expect(live.verifiedAt).toEqual(expect.any(String));
    expect(block(rows, 'gw-a').status).toBe('active');
  });

  it('a changed domain starts over: new token, unverified, the old name no longer served', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    const firstToken = block(rows, 'gw-a').verificationToken;
    publish('_almyty-verify.chat.acme.com', firstToken);
    await service.verify('gw-a', 'org-a', 'u1');

    const moved = await service.set('gw-a', 'org-a', 'u1', 'help.acme.com');
    expect(moved.status).toBe('pending_verification');
    expect(block(rows, 'gw-a').hostname).toBe('help.acme.com');
    expect(block(rows, 'gw-a').verificationToken).not.toBe(firstToken);
    expect(block(rows, 'gw-a').verifiedAt).toBeNull();
    // The old proof does not carry over to the new name.
    expect((await service.verify('gw-a', 'org-a', 'u1')).status).toBe('failed');
  });

  it('setting the hostname a surface already holds changes nothing', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');
    const before = { ...block(rows, 'gw-a') };
    await service.set('gw-a', 'org-a', 'u1', 'CHAT.acme.com');
    expect(block(rows, 'gw-a')).toEqual(before);
  });

  it('one live owner per hostname: while the holder still proves control, a second claim is refused', async () => {
    const { service, rows, publish, notifications } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.shared.com');
    await service.set('gw-b', 'org-b', 'u2', 'chat.shared.com');
    // Both tokens published (say the domain changed hands mid-flight).
    publish('_almyty-verify.chat.shared.com', block(rows, 'gw-a').verificationToken);
    publish('_almyty-verify.chat.shared.com', block(rows, 'gw-b').verificationToken);

    await expect(service.verify('gw-a', 'org-a', 'u1')).resolves.toMatchObject({ status: 'active' });
    await expect(service.verify('gw-b', 'org-b', 'u2')).rejects.toBeInstanceOf(ConflictException);
    expect(block(rows, 'gw-b').status).toBe('failed');
    expect(block(rows, 'gw-b').lastError).toMatch(/already serving/);
    expect(block(rows, 'gw-a').status).toBe('active');
    expect(notifications.sent).toEqual([]);
  });

  it('a pending claim on a name another surface serves is allowed; it serves nothing', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.shared.com');
    publish('_almyty-verify.chat.shared.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');

    const claim = await service.set('gw-b', 'org-b', 'u2', 'chat.shared.com');
    expect(claim.status).toBe('pending_verification');
    expect(block(rows, 'gw-a').status).toBe('active');
  });

  describe('a later rightful owner', () => {
    async function heldByA() {
      const h = harness();
      await h.service.set('gw-a', 'org-a', 'u1', 'chat.shared.com');
      h.publish('_almyty-verify.chat.shared.com', block(h.rows, 'gw-a').verificationToken);
      await h.service.verify('gw-a', 'org-a', 'u1');
      await h.service.set('gw-b', 'org-b', 'u2', 'chat.shared.com');
      return h;
    }

    it('takes the name over once the holder record is gone and theirs is published, demoting the holder', async () => {
      const { service, rows, publish, unpublish, notifications } = await heldByA();
      unpublish('_almyty-verify.chat.shared.com', block(rows, 'gw-a').verificationToken);
      publish('_almyty-verify.chat.shared.com', block(rows, 'gw-b').verificationToken);

      await expect(service.verify('gw-b', 'org-b', 'u2')).resolves.toMatchObject({ status: 'active' });
      expect(block(rows, 'gw-b').status).toBe('active');
      expect(block(rows, 'gw-a')).toMatchObject({ status: 'failed', lastError: DOMAIN_TAKEN_OVER_MESSAGE });
      // Exactly one live owner afterwards.
      expect([...rows.values()].filter((r) => r.customDomain?.status === 'active').map((r) => r.id)).toEqual(['gw-b']);
      // The demoted organization's admins are told, nobody else.
      expect(notifications.sent).toHaveLength(1);
      expect(notifications.sent[0]).toMatchObject({
        type: 'domains.unverified',
        organizationId: 'org-a',
        roleTarget: { orgRoles: ['owner', 'admin'] },
        link: '/gateways/gw-a',
      });
    });

    it('a private holder\'s loss of the name is told to its owner alone', async () => {
      const h = await heldByA();
      Object.assign(h.rows.get('gw-a')!, { visibility: 'private', ownerUserId: 'u1' });
      h.unpublish('_almyty-verify.chat.shared.com', block(h.rows, 'gw-a').verificationToken);
      h.publish('_almyty-verify.chat.shared.com', block(h.rows, 'gw-b').verificationToken);

      await expect(h.service.verify('gw-b', 'org-b', 'u2')).resolves.toMatchObject({ status: 'active' });
      expect(h.notifications.sent).toHaveLength(1);
      expect(h.notifications.sent[0]).toMatchObject({ type: 'domains.unverified', organizationId: 'org-a', userIds: ['u1'] });
      expect(h.notifications.sent[0].roleTarget).toBeUndefined();
    });

    it('does not take over while the holder record still resolves', async () => {
      const { service, rows, publish } = await heldByA();
      publish('_almyty-verify.chat.shared.com', block(rows, 'gw-b').verificationToken);
      await expect(service.verify('gw-b', 'org-b', 'u2')).rejects.toMatchObject({ response: { code: 'DOMAIN_ALREADY_CLAIMED' } });
      expect(block(rows, 'gw-a').status).toBe('active');
    });

    it('does not take over on a DNS error about the holder record', async () => {
      const h = await heldByA();
      const holderToken = block(h.rows, 'gw-a').verificationToken;
      const newToken = block(h.rows, 'gw-b').verificationToken;
      let calls = 0;
      const flaky = new CustomDomainService(
        { findManageable: async (id: string) => copy(h.rows.get(id)) } as any,
        h.store,
        async () => {
          calls++;
          // First lookup (the new claim) finds its record; the second
          // (the holder's) times out, which proves nothing.
          if (calls === 1) return [[`${VERIFICATION_VALUE_PREFIX}${newToken}`]];
          throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
        },
        h.notifications as any,
      );
      await expect(flaky.verify('gw-b', 'org-b', 'u2')).rejects.toMatchObject({ response: { code: 'DOMAIN_ALREADY_CLAIMED' } });
      expect(block(h.rows, 'gw-a')).toMatchObject({ status: 'active', verificationToken: holderToken });
      expect(h.notifications.sent).toEqual([]);
    });

    it('refuses rather than demoting a holder whose claim changed during the check', async () => {
      const h = await heldByA();
      const holderToken = block(h.rows, 'gw-a').verificationToken;
      h.unpublish('_almyty-verify.chat.shared.com', holderToken);
      h.publish('_almyty-verify.chat.shared.com', block(h.rows, 'gw-b').verificationToken);
      let calls = 0;
      const racing = new CustomDomainService(
        { findManageable: async (id: string) => copy(h.rows.get(id)) } as any,
        h.store,
        async (name) => {
          calls++;
          if (calls === 2) {
            // While the holder's record is being looked up, the holder
            // re-verifies with a fresh token.
            h.rows.get('gw-a')!.customDomain = { ...block(h.rows, 'gw-a'), verificationToken: 'fresh', lastCheckedAt: 'now' };
          }
          const values = h.txt[name];
          if (!values) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
          return values.map((v) => [v]);
        },
        h.notifications as any,
      );
      await expect(racing.verify('gw-b', 'org-b', 'u2')).rejects.toBeInstanceOf(ConflictException);
      expect(block(h.rows, 'gw-a').status).toBe('active');
      expect(block(h.rows, 'gw-b').status).not.toBe('active');
      expect(h.notifications.sent).toEqual([]);
    });
  });

  it('a domain whose record disappeared stops being served; a DNS hiccup does not unpublish it', async () => {
    const { service, rows, publish, txt } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');

    delete txt['_almyty-verify.chat.acme.com'];
    expect((await service.verify('gw-a', 'org-a', 'u1')).status).toBe('failed');

    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');
    const flaky = harness({
      resolver: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
    });
    flaky.rows.get('gw-a')!.customDomain = { ...block(rows, 'gw-a') };
    const view = await flaky.service.verify('gw-a', 'org-a', 'u1');
    expect(view.status).toBe('active');
    expect(view.lastError).toMatch(/Could not read DNS/);
  });

  it('never activates on the proof of a claim that changed while it was checked', async () => {
    let service!: CustomDomainService;
    const h = harness({
      resolver: async () => {
        // The tenant repoints the surface while our lookup is in flight.
        await service.set('gw-a', 'org-a', 'u1', 'other.acme.com');
        return [[`${VERIFICATION_VALUE_PREFIX}${stale}`]];
      },
    });
    service = h.service;
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    const stale = block(h.rows, 'gw-a').verificationToken;
    await expect(service.verify('gw-a', 'org-a', 'u1')).rejects.toMatchObject({
      response: { code: 'DOMAIN_CHANGED' },
    });
    expect(block(h.rows, 'gw-a')).toMatchObject({ hostname: 'other.acme.com', status: 'pending_verification' });
  });

  it.each([
    ['https://chat.acme.com', 'DOMAIN_INVALID'],
    ['*.acme.com', 'DOMAIN_INVALID'],
    ['localhost', 'DOMAIN_INVALID'],
    ['acme.almyty.app', 'DOMAIN_RESERVED'],
    ['evil.almyty.com', 'DOMAIN_RESERVED'],
  ])('refuses %s', async (hostname, code) => {
    const { service } = harness();
    await expect(service.set('gw-a', 'org-a', 'u1', hostname)).rejects.toMatchObject({ response: { code } });
  });

  it('is for hosted chat surfaces the caller may manage in their own organization', async () => {
    const { service } = harness();
    await expect(service.set('gw-w', 'org-a', 'u1', 'chat.acme.com')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('gw-b', 'org-a', 'u1', 'chat.acme.com')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.verify('gw-a', 'org-a', 'viewer')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('removing the domain stops serving it', async () => {
    const { service, rows, publish } = harness();
    await service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    publish('_almyty-verify.chat.acme.com', block(rows, 'gw-a').verificationToken);
    await service.verify('gw-a', 'org-a', 'u1');
    await service.remove('gw-a', 'org-a', 'u1');
    expect(rows.get('gw-a')!.customDomain).toBeNull();
    await expect(service.get('gw-a', 'org-a', 'u1')).resolves.toBeNull();
  });
});

describe('the daily re-check of live domains', () => {
  const DAY = RECHECK_AFTER_MS;
  const t0 = new Date('2026-09-01T00:00:00Z');
  const at = (days: number) => new Date(t0.getTime() + days * DAY);

  async function live() {
    const h = harness();
    await h.service.set('gw-a', 'org-a', 'u1', 'chat.acme.com');
    h.publish('_almyty-verify.chat.acme.com', block(h.rows, 'gw-a').verificationToken);
    await h.service.verify('gw-a', 'org-a', 'u1');
    // Pin the last check to t0 so "due" is deterministic.
    h.rows.get('gw-a')!.customDomain!.lastCheckedAt = t0.toISOString();
    return h;
  }

  it('refreshes a domain whose record is still there', async () => {
    const { service, rows, notifications } = await live();
    await expect(service.recheckDue(at(1))).resolves.toEqual({ checked: 1, demoted: 0 });
    expect(block(rows, 'gw-a')).toMatchObject({ status: 'active', lastCheckedAt: at(1).toISOString(), consecutiveFailures: 0 });
    expect(notifications.sent).toEqual([]);
  });

  it('skips a domain checked less than a day ago', async () => {
    const { service, rows } = await live();
    await expect(service.recheckDue(new Date(t0.getTime() + 60 * 1000))).resolves.toEqual({ checked: 0, demoted: 0 });
    expect(block(rows, 'gw-a').lastCheckedAt).toBe(t0.toISOString());
  });

  it(`keeps serving through ${RECHECK_FAILURES_BEFORE_DEMOTION - 1} missed checks, then stops and tells the org admins once`, async () => {
    const { service, rows, txt, notifications } = await live();
    delete txt['_almyty-verify.chat.acme.com'];

    for (let day = 1; day < RECHECK_FAILURES_BEFORE_DEMOTION; day++) {
      await service.recheckDue(at(day));
      expect(block(rows, 'gw-a')).toMatchObject({ status: 'active', consecutiveFailures: day });
    }
    await expect(service.recheckDue(at(RECHECK_FAILURES_BEFORE_DEMOTION))).resolves.toEqual({ checked: 1, demoted: 1 });
    expect(block(rows, 'gw-a')).toMatchObject({ status: 'failed', lastError: DOMAIN_DEMOTED_MESSAGE });
    expect(notifications.sent).toHaveLength(1);
    expect(notifications.sent[0]).toMatchObject({
      type: 'domains.unverified',
      organizationId: 'org-a',
      roleTarget: { orgRoles: ['owner', 'admin'] },
      email: { template: 'domains.unverified', params: { hostname: 'chat.acme.com' } },
    });

    // A demoted domain is no longer live, so later ticks leave it alone.
    await expect(service.recheckDue(at(RECHECK_FAILURES_BEFORE_DEMOTION + 1))).resolves.toEqual({ checked: 0, demoted: 0 });
    expect(notifications.sent).toHaveLength(1);
  });

  it('a private gateway\'s demoted domain is told to its owner alone, not the org admins', async () => {
    const h = await live();
    Object.assign(h.rows.get('gw-a')!, { visibility: 'private', ownerUserId: 'u1' });
    delete h.txt['_almyty-verify.chat.acme.com'];
    for (let day = 1; day <= RECHECK_FAILURES_BEFORE_DEMOTION; day++) await h.service.recheckDue(at(day));

    expect(block(h.rows, 'gw-a').status).toBe('failed');
    expect(h.notifications.sent).toHaveLength(1);
    expect(h.notifications.sent[0]).toMatchObject({ type: 'domains.unverified', userIds: ['u1'], link: '/gateways/gw-a' });
    expect(h.notifications.sent[0].roleTarget).toBeUndefined();
  });

  it('a private gateway with no recorded owner: its demotion is told to nobody', async () => {
    const h = await live();
    Object.assign(h.rows.get('gw-a')!, { visibility: 'private', ownerUserId: null });
    delete h.txt['_almyty-verify.chat.acme.com'];
    for (let day = 1; day <= RECHECK_FAILURES_BEFORE_DEMOTION; day++) await h.service.recheckDue(at(day));

    expect(block(h.rows, 'gw-a').status).toBe('failed');
    expect(h.notifications.sent).toEqual([]);
  });

  it('a record that comes back resets the count', async () => {
    const { service, rows, txt, publish } = await live();
    const token = block(rows, 'gw-a').verificationToken;
    delete txt['_almyty-verify.chat.acme.com'];
    await service.recheckDue(at(1));
    await service.recheckDue(at(2));
    publish('_almyty-verify.chat.acme.com', token);
    await service.recheckDue(at(3));
    expect(block(rows, 'gw-a')).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    delete txt['_almyty-verify.chat.acme.com'];
    await service.recheckDue(at(4));
    expect(block(rows, 'gw-a')).toMatchObject({ status: 'active', consecutiveFailures: 1 });
  });

  it('a DNS error counts nothing', async () => {
    const h = await live();
    const flaky = new CustomDomainService(
      { findManageable: async () => null } as any,
      h.store,
      async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
      h.notifications as any,
    );
    for (let day = 1; day <= RECHECK_FAILURES_BEFORE_DEMOTION + 1; day++) await flaky.recheckDue(at(day));
    expect(block(h.rows, 'gw-a')).toMatchObject({ status: 'active' });
    expect(block(h.rows, 'gw-a').consecutiveFailures ?? 0).toBe(0);
    expect(h.notifications.sent).toEqual([]);
  });

  it('two workers on the same tick count one failure, not two', async () => {
    const { service, rows, txt } = await live();
    delete txt['_almyty-verify.chat.acme.com'];
    const results = await Promise.all([service.recheckDue(at(1)), service.recheckDue(at(1))]);
    expect(results.map((r) => r.checked).sort()).toEqual([0, 1]);
    expect(block(rows, 'gw-a').consecutiveFailures).toBe(1);
  });

  it('does not overwrite a claim removed while it was being checked', async () => {
    const h = await live();
    const racing = new CustomDomainService(
      { findManageable: async () => null } as any,
      h.store,
      async () => {
        h.rows.get('gw-a')!.customDomain = null;
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      },
      h.notifications as any,
    );
    await racing.recheckDue(at(1));
    expect(h.rows.get('gw-a')!.customDomain).toBeNull();
  });
});

describe('custom domains are wired', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('GatewaysModule registers the controller, the service and the Postgres store', () => {
    const mod = src('gateways.module.ts');
    expect(mod).toMatch(/controllers:\s*\[[\s\S]*?\bCustomDomainController\b/);
    expect(mod).toMatch(/providers:\s*\[[\s\S]*?\bCustomDomainService\b/);
    expect(mod).toMatch(/provide:\s*CUSTOM_DOMAIN_STORE,\s*useClass:\s*PgCustomDomainStore/);
  });

  it('the controller routes get, set, verify and remove under /gateways/:gatewayId/custom-domain', () => {
    const ctl = src('channels/custom-domain.controller.ts');
    expect(ctl).toMatch(/@Controller\('gateways'\)/);
    for (const route of [
      "@Get(':gatewayId/custom-domain')",
      "@Put(':gatewayId/custom-domain')",
      "@Post(':gatewayId/custom-domain/verify')",
      "@Delete(':gatewayId/custom-domain')",
    ]) {
      expect(ctl).toContain(route);
    }
    expect(ctl).toMatch(/@UseGuards\(JwtAuthGuard, RolesGuard, PrivateGatewayGuard\)/);
  });

  it('the hosted chat page on a custom domain is resolved only through active rows of the column', () => {
    const svc = src('channels/hosted-chat.service.ts');
    expect(svc).toMatch(/gateway\.customDomain ->> 'status' = :status", \{\s*status: 'active'/);
  });

  it('the re-check runs on a timer outside tests and notifies through the shared pipeline', () => {
    const svc = src('channels/custom-domain.service.ts');
    expect(svc).toMatch(/onModuleInit\(\): void \{[\s\S]*?setInterval\([\s\S]*?this\.recheckDue\(\)/);
    expect(svc).toMatch(/this\.notifications\?\.emit\(/);
  });

  it('no TypeORM save writes the claim: the column is update: false, insert: false', () => {
    const entity = readFileSync(join(__dirname, '../../../../entities/gateway.entity.ts'), 'utf8');
    expect(entity).toMatch(/@Column\(\{ type: 'jsonb', nullable: true, update: false, insert: false \}\)\s*customDomain: CustomDomainConfig \| null;/);
    // And the generic update drops a stray configuration key.
    expect(src('gateways.service.ts')).toMatch(/stripCustomDomainFromConfiguration\(updateGatewayDto\.configuration\)/);
  });

  it('the dashboard calls these routes', () => {
    const api = readFileSync(join(__dirname, '../../../../../../frontend/src/lib/api.ts'), 'utf8');
    expect(api).toMatch(/\/custom-domain\/verify/);
  });
});
