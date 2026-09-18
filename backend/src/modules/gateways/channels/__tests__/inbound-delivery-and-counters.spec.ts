import { createHmac } from 'crypto';
import { EventEmitter } from 'events';

import { ChannelGatewayService } from '../channel-gateway.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { ChatWidgetAdapter } from '../adapters/chat-widget.adapter';
import { SlackAdapter } from '../adapters/slack.adapter';
import { DiscordAdapter } from '../adapters/discord.adapter';
import { TelegramAdapter } from '../adapters/telegram.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { WhatsAppCloudAdapter } from '../adapters/whatsapp-cloud.adapter';
import { SmsAdapter } from '../adapters/sms.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { WebhookAdapter } from '../adapters/webhook.adapter';
import { GoogleChatAdapter } from '../adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../adapters/microsoft-teams.adapter';
import { SignalAdapter } from '../adapters/signal.adapter';
import { MatrixAdapter } from '../adapters/matrix.adapter';
import { IrcAdapter } from '../adapters/irc.adapter';
import { installFetchMock } from '../adapters/__tests__/test-helpers';

/**
 * Two things the inbound channel pipeline has to get right when more
 * than one thing is happening at once:
 *
 *   1. The request counter must not carry the rest of the gateway row
 *      with it. The entity is loaded at the top of the handler and the
 *      counter is written at the bottom, hundreds of milliseconds and
 *      several awaits later; a save() of that stale entity wrote its
 *      `status` and `configuration` back over whatever was committed in
 *      between, so an admin could not turn a busy gateway off and a
 *      credential rotation was reverted by the next message.
 *
 *   2. One delivery must produce one run. Every platform retries, the
 *      controller answers 200 before this runs, and the retry lands on
 *      another replica whose thread lookup cannot yet see the run being
 *      created — so one user message became two runs, two LLM bills and
 *      two replies.
 */
const SIGNING_SECRET = 'inbound-concurrency-secret';

describe('inbound channel pipeline under concurrency', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  let runRepository: any;
  let eventRepository: any;
  let gatewayRows: Map<string, any>;
  let gatewayRepository: any;
  let agentRuntimeService: any;
  let redis: any;
  let emitter: EventEmitter;

  /** The entity a handler is holding: a snapshot, not the live row. */
  const loadedGateway = (type = GatewayType.SLACK): Gateway => {
    const gateway = new Gateway();
    gateway.id = 'gw-1';
    gateway.type = type;
    gateway.status = GatewayStatus.ACTIVE;
    gateway.agentId = 'agent-1';
    gateway.organizationId = 'org-1';
    gateway.configuration = { bot_token: 'xoxb-old', signing_secret: SIGNING_SECRET };
    gateway.totalRequests = 0;
    gateway.successfulRequests = 0;
    return gateway;
  };

  const slackEvent = (eventId: string, ts = '111.222') => ({
    event_id: eventId,
    event: { type: 'message', text: 'hi there', user: 'U1', channel: 'C1', ts },
  });

  const signedHeaders = (payload: unknown): Record<string, string> => {
    const timestamp = '1700000000';
    const basestring = `v0:${timestamp}:${JSON.stringify(payload)}`;
    return {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature':
        'v0=' + createHmac('sha256', SIGNING_SECRET).update(basestring).digest('hex'),
    };
  };

  const buildService = (withRedis = false) =>
    new ChannelGatewayService(
      gatewayRepository,
      runRepository,
      eventRepository,
      agentRuntimeService,
      new ChatWidgetAdapter(null as any),
      new SlackAdapter(),
      new DiscordAdapter(),
      new TelegramAdapter(),
      new WhatsAppAdapter(),
      new WhatsAppCloudAdapter(),
      new SmsAdapter(),
      new EmailAdapter(),
      new WebhookAdapter(),
      new GoogleChatAdapter(),
      new MicrosoftTeamsAdapter(),
      new SignalAdapter(),
      new MatrixAdapter(),
      new IrcAdapter(),
      undefined,
      undefined,
      undefined,
      undefined,
      withRedis ? redis : undefined,
    );

  beforeEach(() => {
    fetchMock = installFetchMock();
    emitter = new EventEmitter();

    const run: any = { id: 'run-1', metadata: {}, output: 'agent says hi' };
    runRepository = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
      save: jest.fn(async (r: any) => r),
      findOne: jest.fn(async () => run),
    };

    // channel_events with the real unique (gatewayId, deliveryId)
    // behaviour. The index IS the dedupe, so a fake that accepted every
    // insert would let the double-run back in silently. The query
    // builder models the conditional takeover UPDATE, so a claim left
    // behind by a dead replica can be reclaimed exactly as in Postgres,
    // and `update` models the outcome write that moves a finished claim
    // out of `received` — without which every handled delivery stays
    // takeable forever.
    eventRepository = {
      rows: [] as any[],
      nextId: 1,
      create: jest.fn((data: any) => data),
      save: jest.fn(async (e: any) => {
        if (
          e.deliveryId &&
          eventRepository.rows.some(
            (r: any) => r.gatewayId === e.gatewayId && r.deliveryId === e.deliveryId,
          )
        ) {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        const stored = { id: `evt-${eventRepository.nextId++}`, createdAt: new Date(), ...e };
        eventRepository.rows.push(stored);
        return stored;
      }),
      update: jest.fn(async (where: any, patch: any) => {
        const target = eventRepository.rows.find((r: any) =>
          where.id
            ? r.id === where.id
            : r.gatewayId === where.gatewayId && r.deliveryId === where.deliveryId,
        );
        if (target) Object.assign(target, patch);
        return { affected: target ? 1 : 0 };
      }),
      createQueryBuilder: jest.fn(() => {
        const params: Record<string, any> = {};
        let patch: Record<string, any> = {};
        const qb: any = {
          update: () => qb,
          set: (values: Record<string, any>) => { patch = values; return qb; },
          where: (_c: string, p: any) => { Object.assign(params, p); return qb; },
          andWhere: (_c: string, p: any) => { Object.assign(params, p ?? {}); return qb; },
          execute: async () => {
            const match = eventRepository.rows.find(
              (r: any) =>
                r.gatewayId === params.gatewayId &&
                r.deliveryId === params.deliveryId &&
                r.status === params.received &&
                r.createdAt < params.cutoff,
            );
            if (!match) return { affected: 0 };
            for (const [key, value] of Object.entries(patch)) {
              match[key] = typeof value === 'function' ? new Date() : value;
            }
            return { affected: 1 };
          },
        };
        return qb;
      }),
    };

    // The live gateways table. save() replaces the whole row (that is
    // what TypeORM's save of a loaded entity does); the query builder
    // writes only the columns in set().
    gatewayRows = new Map<string, any>();
    gatewayRows.set('gw-1', {
      id: 'gw-1',
      status: GatewayStatus.ACTIVE,
      configuration: { bot_token: 'xoxb-old', signing_secret: SIGNING_SECRET },
      totalRequests: 0,
      successfulRequests: 0,
      lastRequestAt: null,
    });
    gatewayRepository = {
      save: jest.fn(async (g: any) => {
        gatewayRows.set(g.id, {
          id: g.id,
          status: g.status,
          configuration: g.configuration,
          totalRequests: g.totalRequests,
          successfulRequests: g.successfulRequests,
          lastRequestAt: g.lastRequestAt ?? null,
        });
        return g;
      }),
      createQueryBuilder: jest.fn(() => {
        let patch: Record<string, any> = {};
        let targetId: string | undefined;
        const qb: any = {
          update: () => qb,
          set: (values: Record<string, any>) => { patch = values; return qb; },
          where: (_clause: string, params: any) => { targetId = params.id; return qb; },
          execute: async () => {
            const row = gatewayRows.get(targetId!);
            if (!row) return { affected: 0 };
            for (const [key, value] of Object.entries(patch)) {
              if (typeof value === 'function') {
                // `() => '"totalRequests" + 1'` and friends.
                const sql = String(value());
                const column = sql.replace(/"/g, '').split(' ')[0];
                row[key] = sql.includes('+ 1') ? (row[column] ?? 0) + 1 : row[column];
              } else {
                row[key] = value;
              }
            }
            return { affected: 1 };
          },
        };
        return qb;
      }),
    };

    agentRuntimeService = {
      startRun: jest.fn(async () => run),
      sendInput: jest.fn(async () => run),
      getRunEmitter: jest.fn(() => emitter),
    };

    redis = {
      keys: new Set<string>(),
      setCalls: [] as Array<{ key: string; ttl: number }>,
      set: jest.fn(async (key: string, _value: string, _ex: string, ttl: number) => {
        redis.setCalls.push({ key, ttl });
        if (redis.keys.has(key)) return null;
        redis.keys.add(key);
        return 'OK';
      }),
    };
  });

  afterEach(() => fetchMock.restore());

  // ── 1. the counter must not clobber the row ───────────────────────────

  it('an inbound message counted mid-flight does not resurrect a deactivated gateway', async () => {
    const service = buildService();
    const gateway = loadedGateway();
    const payload = slackEvent('Ev1');

    // The admin deactivates and rotates while the handler is between
    // its config resolution and its counter write.
    agentRuntimeService.startRun.mockImplementation(async () => {
      gatewayRows.set('gw-1', {
        ...gatewayRows.get('gw-1'),
        status: GatewayStatus.INACTIVE,
        configuration: { bot_token: 'xoxb-rotated', signing_secret: SIGNING_SECRET },
      });
      return { id: 'run-1', metadata: {}, output: 'agent says hi' };
    });

    await service.handleInboundMessage(gateway, payload, signedHeaders(payload));

    const row = gatewayRows.get('gw-1');
    expect(row.status).toBe(GatewayStatus.INACTIVE);
    expect(row.configuration.bot_token).toBe('xoxb-rotated');
    expect(row.totalRequests).toBe(1);
    expect(gatewayRepository.save).not.toHaveBeenCalled();
  });

  it('a widget message counted mid-flight does not resurrect a deactivated gateway', async () => {
    const service = buildService();
    const gateway = loadedGateway(GatewayType.CHAT_WIDGET);

    agentRuntimeService.startRun.mockImplementation(async () => {
      gatewayRows.set('gw-1', {
        ...gatewayRows.get('gw-1'),
        status: GatewayStatus.INACTIVE,
      });
      return { id: 'run-1', metadata: {}, output: 'agent says hi' };
    });

    await service.handleWidgetMessage(gateway, { message: 'hello', sessionId: 's-1' });

    const row = gatewayRows.get('gw-1');
    expect(row.status).toBe(GatewayStatus.INACTIVE);
    expect(row.totalRequests).toBe(1);
    expect(gatewayRepository.save).not.toHaveBeenCalled();
  });

  it('two requests each add one, rather than losing an increment to a read-modify-write', async () => {
    const service = buildService();
    const first = slackEvent('Ev1', '111.001');
    const second = slackEvent('Ev2', '111.002');

    // Both handlers hold their own entity loaded at totalRequests = 0,
    // which is exactly the interleaving a read-modify-write loses.
    await Promise.all([
      service.handleInboundMessage(loadedGateway(), first, signedHeaders(first)),
      service.handleInboundMessage(loadedGateway(), second, signedHeaders(second)),
    ]);

    expect(gatewayRows.get('gw-1').totalRequests).toBe(2);
  });

  // ── 2. one delivery, one run ──────────────────────────────────────────

  it('a redelivered platform event does not start a second run', async () => {
    const service = buildService();
    const payload = slackEvent('Ev-retry');
    const headers = signedHeaders(payload);

    await service.handleInboundMessage(loadedGateway(), payload, headers);
    // Slack retries the same event_id; a different replica, so nothing
    // in memory tells it this was already handled.
    await service.handleInboundMessage(loadedGateway(), payload, headers);

    expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
    expect(gatewayRows.get('gw-1').totalRequests).toBe(1);
  });

  it('two genuinely different events both run', async () => {
    const service = buildService();
    const first = slackEvent('Ev-a', '111.001');
    const second = slackEvent('Ev-b', '111.002');

    await service.handleInboundMessage(loadedGateway(), first, signedHeaders(first));
    await service.handleInboundMessage(loadedGateway(), second, signedHeaders(second));

    expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(2);
  });

  it('the Redis fast path turns the duplicate away without a second event insert', async () => {
    const service = buildService(true);
    const payload = slackEvent('Ev-cached');
    const headers = signedHeaders(payload);

    await service.handleInboundMessage(loadedGateway(), payload, headers);
    const insertsAfterFirst = eventRepository.save.mock.calls.length;
    await service.handleInboundMessage(loadedGateway(), payload, headers);

    expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
    expect(eventRepository.save.mock.calls.length).toBe(insertsAfterFirst);
    expect(redis.set).toHaveBeenCalledWith(
      'channel_delivery:gw-1:slack:Ev-cached',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('an unreachable Redis falls through to the index rather than dropping the message', async () => {
    redis.set = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const service = buildService(true);
    const payload = slackEvent('Ev-redis-down');

    await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));

    expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
  });

  it('a channel with no stable delivery id is still processed', async () => {
    const service = buildService();
    const gateway = loadedGateway(GatewayType.IRC);
    gateway.configuration = { inbound_token: 'tok', webhook_url: 'https://irc.example/hook' };

    // IRC's bridge payload carries no delivery id, so the dedupe cannot
    // help — but it must not refuse the message either.
    await service.handleInboundMessage(
      gateway,
      { text: 'hi', nick: 'n1', channel: '#dev' },
      { authorization: 'Bearer tok' },
    );

    expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
    expect(eventRepository.rows[0].deliveryId).toBeNull();
  });

  // ── 3. threadId travels with the run row ──────────────────────────────

  it('the thread id is written as part of the run insert, not a follow-up save', async () => {
    const service = buildService();
    const payload = slackEvent('Ev-thread');

    await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));

    const [, , , , options] = agentRuntimeService.startRun.mock.calls[0];
    expect(options.metadata).toMatchObject({
      threadId: '111.222',
      gatewayId: 'gw-1',
      channelUserId: 'U1',
    });
    // A second write would leave a window in which the run exists with
    // no threadId on it, which is exactly what let a concurrent message
    // in the same thread start its own run.
    expect(runRepository.save).not.toHaveBeenCalled();
  });

  /**
   * A claim is a lease, not a tombstone.
   *
   * Keying the claim on the delivery id alone makes the pipeline
   * at-most-once: a replica that claims a delivery and then dies — OOM,
   * eviction, a rolling deploy — leaves a claim nobody is working on,
   * and the platform's retry is turned away by the unique index. The
   * user's message is then dropped in silence, with an event row that
   * says `received` and a Slack thread that never gets an answer.
   * Trading two replies for no reply is not a fix.
   */
  describe('a claim abandoned by a dead replica', () => {
    /**
     * Put a claim in the table as if a replica took it and never
     * finished.
     *
     * The id is the adapter's, not the platform's: SlackAdapter returns
     * `slack:<event_id>`. Planting the bare event id looks right and
     * matches nothing, so the insert never hits the unique index and the
     * test silently exercises the ordinary path instead of the takeover.
     */
    const plantStaleClaim = (eventId: string, ageMs: number, status = 'received') => {
      eventRepository.rows.push({
        gatewayId: 'gw-1',
        deliveryId: `slack:${eventId}`,
        direction: 'inbound',
        status,
        createdAt: new Date(Date.now() - ageMs),
      });
    };

    it('is taken over on the redelivery, so the message still gets answered', async () => {
      const service = buildService();
      const payload = slackEvent('Ev-abandoned');
      plantStaleClaim('Ev-abandoned', 11 * 60 * 1000);

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));

      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
    });

    it('is left alone while the lease is still good, so a live run is not doubled', async () => {
      const service = buildService();
      const payload = slackEvent('Ev-inflight');
      plantStaleClaim('Ev-inflight', 30 * 1000);

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));

      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
    });

    it('is not taken over once somebody finished it, however old it is', async () => {
      const service = buildService();
      const payload = slackEvent('Ev-done');
      plantStaleClaim('Ev-done', 24 * 60 * 60 * 1000, 'processed');

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));

      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
    });

    it('produces exactly one winner when several retries arrive together', async () => {
      const service = buildService();
      const payload = slackEvent('Ev-thundering');
      plantStaleClaim('Ev-thundering', 11 * 60 * 1000);

      // The takeover is conditional on the row still looking abandoned,
      // so the first one to move it wins and the rest see nothing to take.
      await Promise.all([
        service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload)),
        service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload)),
        service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload)),
      ]);

      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
    });

    it('does not let the cache outlive the lease and drop a takeable delivery', async () => {
      // A cache hit short-circuits before the row is consulted, so a
      // cache entry that survived longer than the lease would drop a
      // redelivery the lease says is now takeable.
      const service = buildService(true);
      const payload = slackEvent('Ev-cache-lease');
      plantStaleClaim('Ev-cache-lease', 11 * 60 * 1000);

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));

      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
      // And the cache was asked to hold it for no longer than the lease.
      const ttls = redis.setCalls.map((c: any) => c.ttl);
      for (const ttl of ttls) expect(ttl).toBeLessThanOrEqual(10 * 60);
    });
  });

  /**
   * The claim has to reach a terminal state, or the lease above is a
   * lie.
   *
   * `reclaimAbandonedDelivery` reads "still `received` past the lease"
   * as "the replica that took this died". Nothing used to move a claim
   * out of `received`, so a delivery that was answered perfectly well
   * read as abandoned forever — and Slack's third retry, thirty minutes
   * after the event, was handed the lease and started a second run, a
   * second LLM bill and a second reply to the same question. The lease
   * is only correct once a finished delivery says so.
   */
  describe('a delivery that was actually handled', () => {
    /** Emit completion and let the async reply dispatch settle. */
    const completeRun = async () => {
      emitter.emit('event', { type: 'run.completed' });
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const inboundRow = () => eventRepository.rows.find((r: any) => r.direction === 'inbound');

    it('reaches processed and carries the run it produced', async () => {
      fetchMock.setNextResponse({ json: { ok: true, ts: '1700000000.200' } });
      const service = buildService();
      const payload = slackEvent('Ev-handled');

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));
      await completeRun();

      expect(inboundRow()).toMatchObject({ status: 'processed', runId: 'run-1' });
    });

    it('is not reclaimable once handled, however long the platform keeps retrying', async () => {
      fetchMock.setNextResponse({ json: { ok: true, ts: '1700000000.200' } });
      const service = buildService();
      const payload = slackEvent('Ev-handled-then-retried');
      const headers = signedHeaders(payload);

      await service.handleInboundMessage(loadedGateway(), payload, headers);
      await completeRun();
      expect(inboundRow().status).toBe('processed');

      // Slack's last retry lands well past the lease. Before the claim
      // could reach `processed` this was taken over as abandoned.
      inboundRow().createdAt = new Date(Date.now() - 31 * 60 * 1000);
      await service.handleInboundMessage(loadedGateway(), payload, headers);

      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
    });

    it('reaches failed with the platform\'s reason when the platform refused the reply', async () => {
      // HTTP 200 with ok:false is how Slack says no.
      fetchMock.setNextResponse({ ok: true, status: 200, json: { ok: false, error: 'not_in_channel' } });
      const service = buildService();
      const payload = slackEvent('Ev-refused');

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));
      await completeRun();

      const inbound = inboundRow();
      expect(inbound.status).toBe('failed');
      expect(inbound.errorMessage).toMatch(/not_in_channel/);
      const outbound = eventRepository.rows.find((r: any) => r.direction === 'outbound');
      expect(outbound).toMatchObject({ status: 'failed', runId: 'run-1' });
      expect(outbound.errorMessage).toMatch(/not_in_channel/);
    });

    it('is not reclaimable once it failed either — the answer was attempted and billed', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: { ok: false, error: 'channel_not_found' } });
      const service = buildService();
      const payload = slackEvent('Ev-failed-then-retried');
      const headers = signedHeaders(payload);

      await service.handleInboundMessage(loadedGateway(), payload, headers);
      await completeRun();
      inboundRow().createdAt = new Date(Date.now() - 31 * 60 * 1000);
      await service.handleInboundMessage(loadedGateway(), payload, headers);

      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
    });

    it('still cross-links the run even while the reply is in flight', async () => {
      // The operator's question — "which run answered the message I
      // sent at 14:05" — has to be answerable before the run finishes,
      // not only after.
      const service = buildService();
      const payload = slackEvent('Ev-inflight-link');

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));

      expect(inboundRow()).toMatchObject({ status: 'received', runId: 'run-1' });
    });
  });

  /**
   * The emitter is process-local and the run travels through BullMQ, so
   * a run can finish on a replica that never saw the registration, or
   * after this pod was recycled. The reply is then never sent. The only
   * trace used to be one warning line carrying a run id: no event row,
   * nothing on the run, nothing an operator could search.
   */
  describe('a run whose listener is not in this process', () => {
    it('files an outbound failure naming the cause and the run', async () => {
      agentRuntimeService.getRunEmitter = jest.fn(() => null);
      const service = buildService();
      const payload = slackEvent('Ev-no-emitter');

      await service.handleInboundMessage(loadedGateway(), payload, signedHeaders(payload));
      await new Promise((resolve) => setImmediate(resolve));

      const outbound = eventRepository.rows.find((r: any) => r.direction === 'outbound');
      expect(outbound).toBeDefined();
      expect(outbound.status).toBe('failed');
      expect(outbound.runId).toBe('run-1');
      expect(outbound.errorMessage).toMatch(/no run listener in this process/);
    });

    it('leaves the claim takeable, because nothing answered the message', async () => {
      agentRuntimeService.getRunEmitter = jest.fn(() => null);
      const service = buildService();
      const payload = slackEvent('Ev-no-emitter-retry');
      const headers = signedHeaders(payload);

      await service.handleInboundMessage(loadedGateway(), payload, headers);
      await new Promise((resolve) => setImmediate(resolve));

      const inbound = eventRepository.rows.find((r: any) => r.direction === 'inbound');
      // Cross-linked so the lost run is findable, but still `received`:
      // the platform's retry should get to try again.
      expect(inbound).toMatchObject({ status: 'received', runId: 'run-1' });

      inbound.createdAt = new Date(Date.now() - 11 * 60 * 1000);
      await service.handleInboundMessage(loadedGateway(), payload, headers);
      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(2);
    });
  });
});
