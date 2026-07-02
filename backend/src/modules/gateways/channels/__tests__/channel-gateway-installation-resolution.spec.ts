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
    gateway.configuration = { bot_token: 'xoxb-gateway-default' };
    gateway.totalRequests = 0;
    gateway.successfulRequests = 0;
    return gateway;
  };

  const slackEvent = (teamId?: string) => ({
    ...(teamId ? { team_id: teamId } : {}),
    event: { type: 'message', text: 'hi there', user: 'U1', channel: 'C1', ts: '111.222' },
  });

  const buildService = (withInstallations: boolean) =>
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
    eventRepository = {
      create: jest.fn((data: any) => data),
      save: jest.fn(async (e: any) => e),
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

    await service.handleInboundMessage(makeGateway(), slackEvent('T777'), {});
    await completeRunAndFlush();

    expect(installationService.resolveCredentials).toHaveBeenCalledWith('gw-1', 'T777');
    expect(fetchMock.calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-tenant-T777');
    expect(parseSentJson(fetchMock.calls[0]).text).toBe('agent says hi');
  });

  it('falls back to the gateway configuration when the team never installed', async () => {
    installationService.resolveCredentials.mockResolvedValue(null);
    const service = buildService(true);

    await service.handleInboundMessage(makeGateway(), slackEvent('T404'), {});
    await completeRunAndFlush();

    expect(installationService.resolveCredentials).toHaveBeenCalledWith('gw-1', 'T404');
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
  });

  it('keeps single-credential behavior when the payload has no tenant id', async () => {
    const service = buildService(true);

    await service.handleInboundMessage(makeGateway(), slackEvent(undefined), {});
    await completeRunAndFlush();

    expect(installationService.resolveCredentials).not.toHaveBeenCalled();
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
  });

  it('works unchanged when the installation subsystem is absent (optional dependency)', async () => {
    const service = buildService(false);

    await service.handleInboundMessage(makeGateway(), slackEvent('T777'), {});
    await completeRunAndFlush();

    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
  });

  it('does not fail the inbound pipeline when installation lookup throws', async () => {
    installationService.resolveCredentials.mockRejectedValue(new Error('db down'));
    const service = buildService(true);

    await service.handleInboundMessage(makeGateway(), slackEvent('T777'), {});
    await completeRunAndFlush();

    // Lookup failure degrades to the gateway's own credentials.
    expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-gateway-default');
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
