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
import { installFetchMock, parseSentJson } from '../adapters/__tests__/test-helpers';

/**
 * Multi-workspace resolution in the inbound channel pipeline: when a
 * Slack event carries a team_id with an active installation, the reply
 * is sent with THAT workspace's bot token; without installations the
 * gateway's own single-workspace configuration is used unchanged.
 */
describe('ChannelGatewayService installation resolution', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  let runRepository: any;
  let runRows: any[];
  let eventRepository: any;
  let gatewayRepository: any;
  let agentRuntimeService: any;
  let installationService: any;
  let emitter: EventEmitter;

  const makeGateway = (): Gateway => {
    const gateway = new Gateway();
    gateway.id = 'gw-1';
    gateway.type = GatewayType.SLACK;
    gateway.status = GatewayStatus.ACTIVE;
    gateway.agentId = 'agent-1';
    gateway.organizationId = 'org-1';
    gateway.configuration = { bot_token: 'xoxb-gateway-default', signing_secret: SIGNING_SECRET };
    gateway.totalRequests = 0;
    gateway.successfulRequests = 0;
    return gateway;
  };

  const slackEvent = (teamId?: string) => ({
    ...(teamId ? { team_id: teamId } : {}),
    event: { type: 'message', text: 'hi there', user: 'U1', channel: 'C1', ts: '111.222' },
  });

  /**
   * Inbound now fails closed, so every one of these has to arrive
   * correctly signed or the pipeline refuses it before it ever reaches
   * installation resolution.
   */
  const SIGNING_SECRET = 'installation-resolution-secret';
  const signedHeaders = (payload: unknown): Record<string, string> => {
    const timestamp = String(Math.floor(Date.now() / 1000)); // inside Slack's replay window
    const basestring = `v0:${timestamp}:${JSON.stringify(payload)}`;
    return {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature':
        'v0=' + createHmac('sha256', SIGNING_SECRET).update(basestring).digest('hex'),
    };
  };

  const buildService = (withInstallations: boolean, rateLimit?: any) =>
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
      withInstallations ? installationService : undefined,
      undefined,
      rateLimit,
    );


  beforeEach(() => {
    fetchMock = installFetchMock();
    // Slack confirms a post in the body, not the status, and the
    // adapter now refuses anything else — so a harness that wants a
    // delivered reply has to say so.
    fetchMock.setNextResponse({ json: { ok: true, ts: '1700000000.200' } });
    emitter = new EventEmitter();

    const run: any = { id: 'run-1', metadata: {}, output: 'agent says hi' };
    // The thread-continuation lookup, evaluated against `runRows` rather
    // than answered with a canned `[]`, which could not tell the `agentId`
    // or status predicate from its absence. Unmodelled SQL throws.
    runRows = [];
    const RUN_CLAUSES: Record<string, (row: any, p: any) => boolean> = {
      'run.agentId = :agentId': (row, p) => row.agentId === p.agentId,
      'run.status IN (:...activeStatuses)': (row, p) => p.activeStatuses.includes(row.status),
      "run.metadata->>'threadId' = :threadId": (row, p) => row.metadata?.threadId === p.threadId,
    };
    runRepository = {
      createQueryBuilder: jest.fn(() => {
        const filters: Array<(row: any) => boolean> = [];
        let take = Infinity;
        const add = (clause: string, params: any) => {
          const test = RUN_CLAUSES[clause];
          if (!test) throw new Error(`unmodelled run clause: ${clause}`);
          filters.push((row) => test(row, params));
          return qb;
        };
        const qb: any = {
          where: add,
          andWhere: add,
          orderBy: (column: string, direction: string) => {
            if (column !== 'run.createdAt' || direction !== 'DESC') {
              throw new Error(`unmodelled run order: ${column} ${direction}`);
            }
            return qb;
          },
          limit: (n: number) => {
            take = n;
            return qb;
          },
          getMany: async () =>
            runRows
              .filter((row) => filters.every((f) => f(row)))
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, take),
        };
        return qb;
      }),
      save: jest.fn(async (r: any) => r),
      findOne: jest.fn(async () => run),
    };
    eventRepository = {
      rows: [] as any[],
      nextId: 1,
      create: jest.fn((data: any) => data),
      save: jest.fn(async (e: any) => {
        const stored = { id: `evt-${eventRepository.nextId++}`, ...e };
        eventRepository.rows.push(stored);
        return stored;
      }),
      update: jest.fn(async (where: any, patch: any) => {
        const target = eventRepository.rows.find((r: any) => r.id === where.id);
        if (target) Object.assign(target, patch);
        return { affected: target ? 1 : 0 };
      }),
    };
    gatewayRepository = {
      save: jest.fn(async (g: any) => g),
    };
    agentRuntimeService = {
      startRun: jest.fn(async () => run),
      sendInput: jest.fn(async () => run),
      getRunEmitter: jest.fn(() => emitter),
    };
    installationService = {
      resolveCredentials: jest.fn(),
    };
  });

  afterEach(() => fetchMock.restore());

  /** Drive the run to completion and wait for the async reply dispatch. */
  const completeRunAndFlush = async () => {
    emitter.emit('event', { type: 'run.completed' });
    for (let i = 0; i < 10 && fetchMock.calls.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('replies with the installing workspace token when the team has an active installation', async () => {
    installationService.resolveCredentials.mockResolvedValue({ bot_token: 'xoxb-tenant-T777' });
    const service = buildService(true);

    await service.handleInboundMessage(makeGateway(), slackEvent('T777'), signedHeaders(slackEvent('T777')));
    await completeRunAndFlush();

    expect(installationService.resolveCredentials).toHaveBeenCalledWith('gw-1', 'T777');
    expect(fetchMock.calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-tenant-T777');
    expect(parseSentJson(fetchMock.calls[0]).text).toBe('agent says hi');
  });

  it('falls back to the gateway configuration when the team never installed', async () => {
    installationService.resolveCredentials.mockResolvedValue(null);
    const service = buildService(true);

    await service.handleInboundMessage(makeGateway(), slackEvent('T404'), signedHeaders(slackEvent('T404')));
    await completeRunAndFlush();

    expect(installationService.resolveCredentials).toHaveBeenCalledWith('gw-1', 'T404');
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
  });

  it('keeps single-credential behavior when the payload has no tenant id', async () => {
    const service = buildService(true);

    await service.handleInboundMessage(makeGateway(), slackEvent(undefined), signedHeaders(slackEvent(undefined)));
    await completeRunAndFlush();

    expect(installationService.resolveCredentials).not.toHaveBeenCalled();
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
  });

  it('works unchanged when the installation subsystem is absent (optional dependency)', async () => {
    const service = buildService(false);

    await service.handleInboundMessage(makeGateway(), slackEvent('T777'), signedHeaders(slackEvent('T777')));
    await completeRunAndFlush();

    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
  });

  it('does not fail the inbound pipeline when installation lookup throws', async () => {
    installationService.resolveCredentials.mockRejectedValue(new Error('db down'));
    const service = buildService(true);

    await service.handleInboundMessage(makeGateway(), slackEvent('T777'), signedHeaders(slackEvent('T777')));
    await completeRunAndFlush();

    // Lookup failure degrades to the gateway's own credentials.
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
  });

  describe('per-sender share', () => {
    it('checks the platform sender, not the webhook address, and drops a sender over their share', async () => {
      const rateLimit = {
        checkVisitor: jest.fn(async () => ({ limited: true, code: 'VISITOR_RATE_LIMITED', message: 'Too many messages from you (60 per hour). Please wait 30 seconds.' })),
      };
      const service = buildService(false, rateLimit);

      await service.handleInboundMessage(makeGateway(), slackEvent('T777'), signedHeaders(slackEvent('T777')));

      expect(rateLimit.checkVisitor).toHaveBeenCalledWith(expect.objectContaining({ id: 'gw-1' }), { endUserId: 'U1', clientHash: null });
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
      // The outcome lands on the delivery's own claim row rather than
      // beside it: a claim left in `received` is one the lease hands to
      // the platform's next retry.
      const inbound = eventRepository.rows.find((r: any) => r.direction === 'inbound');
      expect(inbound.status).toBe('failed');
      expect(inbound.errorMessage).toMatch(/Too many messages from you/);
    });

    it('lets a sender under their share through', async () => {
      const rateLimit = { checkVisitor: jest.fn(async () => ({ limited: false })) };
      const service = buildService(false, rateLimit);

      await service.handleInboundMessage(makeGateway(), slackEvent('T777'), signedHeaders(slackEvent('T777')));
      await completeRunAndFlush();

      expect(agentRuntimeService.startRun).toHaveBeenCalled();
    });
  });

  describe('thread continuation', () => {
    const openRun = (over: Record<string, any> = {}) => ({
      id: 'run-thread',
      agentId: 'agent-1',
      status: 'running',
      createdAt: 1,
      metadata: { threadId: '111.222' },
      output: 'agent says hi',
      ...over,
    });
    const deliver = (service: ChannelGatewayService) =>
      service.handleInboundMessage(makeGateway(), slackEvent('T777'), signedHeaders(slackEvent('T777')));

    it('continues the run already open on this thread', async () => {
      runRows.push(openRun());

      await deliver(buildService(false));

      expect(agentRuntimeService.sendInput).toHaveBeenCalledWith('run-thread', 'org-1', 'hi there');
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
    });

    // The thread id is the platform's, not ours: nothing stops the same
    // value appearing against another tenant's agent. `agentId` is what
    // keeps this message out of their conversation.
    it('will not continue a run that belongs to a different agent', async () => {
      runRows.push(openRun({ id: 'run-other-tenant', agentId: 'agent-99' }));

      await deliver(buildService(false));

      expect(agentRuntimeService.sendInput).not.toHaveBeenCalled();
      expect(agentRuntimeService.startRun).toHaveBeenCalled();
    });

    it('will not continue a run that has already finished', async () => {
      runRows.push(openRun({ status: 'completed' }));

      await deliver(buildService(false));

      expect(agentRuntimeService.sendInput).not.toHaveBeenCalled();
      expect(agentRuntimeService.startRun).toHaveBeenCalled();
    });

    it('will not continue a run open on another thread', async () => {
      runRows.push(openRun({ metadata: { threadId: '999.000' } }));

      await deliver(buildService(false));

      expect(agentRuntimeService.sendInput).not.toHaveBeenCalled();
      expect(agentRuntimeService.startRun).toHaveBeenCalled();
    });

    // The widget's thread id is whatever the anonymous visitor sends. With
    // the `agentId` predicate gone, presenting another agent's thread id
    // appended the visitor's text to that run and streamed its replies back.
    describe('from the chat widget', () => {
      const widgetGateway = () => {
        const gateway = makeGateway();
        gateway.type = GatewayType.CHAT_WIDGET;
        return gateway;
      };

      it('continues the visitor\'s own open run', async () => {
        runRows.push(openRun());

        await buildService(false).handleWidgetMessage(widgetGateway(), {
          message: 'hi there',
          threadId: '111.222',
        });

        expect(agentRuntimeService.sendInput).toHaveBeenCalledWith('run-thread', 'org-1', 'hi there');
        expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
      });

      it('will not continue another agent\'s run whose thread id the visitor presents', async () => {
        runRows.push(openRun({ id: 'run-other-tenant', agentId: 'agent-99' }));

        await buildService(false).handleWidgetMessage(widgetGateway(), {
          message: 'hi there',
          threadId: '111.222',
        });

        expect(agentRuntimeService.sendInput).not.toHaveBeenCalled();
        expect(agentRuntimeService.startRun).toHaveBeenCalled();
      });

      it('will not continue a finished run', async () => {
        runRows.push(openRun({ status: 'completed' }));

        await buildService(false).handleWidgetMessage(widgetGateway(), {
          message: 'hi there',
          threadId: '111.222',
        });

        expect(agentRuntimeService.sendInput).not.toHaveBeenCalled();
      });
    });
  });


  describe('tenant id extraction', () => {
    it('slack adapter reads team_id (top level), event.team, and team.id', () => {
      const slack = new SlackAdapter();
      expect(slack.extractTenantId({ team_id: 'T1' })).toBe('T1');
      expect(slack.extractTenantId({ event: { team: 'T2' } })).toBe('T2');
      expect(slack.extractTenantId({ team: { id: 'T3' } })).toBe('T3');
      expect(slack.extractTenantId({})).toBeUndefined();
    });

    it('base adapter default returns undefined (no multi-workspace support)', () => {
      expect(new WebhookAdapter().extractTenantId({ team_id: 'T1' })).toBeUndefined();
    });
  });
});
