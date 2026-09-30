import { BadRequestException } from '@nestjs/common';

import { ChannelGatewayService } from '../channel-gateway.service';
import { ScheduledPostService, resultText } from '../scheduled-post.service';
import { splitMessage, TRUNCATION_NOTE } from '../scheduled-post-targets';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { AgentChannel, ChannelStatus, ChannelType } from '../../../../entities/agent-channel.entity';
import { AgentExecutionStatus } from '../../../../entities/agent-execution.entity';
import { fakeRepository } from '../../../../test/fake-repository';
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
import { IMessageSendblueAdapter } from '../adapters/imessage-sendblue.adapter';
import { IMessageLoopMessageAdapter } from '../adapters/imessage-loopmessage.adapter';
import { installFetchMock, parseSentForm, parseSentJson } from '../adapters/__tests__/test-helpers';

/**
 * A scheduled result posted into a channel goes out through that
 * channel's own adapter -- real adapters here, with only the network
 * faked -- to the destination the schedule names, one platform message
 * per part, with the channel's AI disclosure, recorded on the run and on
 * the channel's activity. One case per platform that can start a message.
 */
describe('ScheduledPostService', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  let gateways: any;
  let channels: any;
  let executions: any;
  let events: any;
  let notifications: { emit: jest.Mock };
  let policies: { forGateway: jest.Mock; reachedFor: jest.Mock };
  let service: ScheduledPostService;
  const slack = new SlackAdapter();

  const agent: any = { id: 'agent-1', name: 'Morning report', organizationId: 'org-1', visibility: 'org', createdBy: 'u-1' };

  const CONFIG: Record<string, Record<string, any>> = {
    slack: { bot_token: 'xoxb-1' },
    microsoft_teams: { bot_id: 'bot', bot_password: 'pw' },
    email: { resend_api_key: 're_1', reply_from: 'agent@example.com' },
    telegram: { bot_token: '123:abc' },
    discord: { bot_token: 'disc' },
    google_chat: { webhook_url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k' },
    whatsapp: { twilio_account_sid: 'AC1', twilio_auth_token: 't', phone_number: '+15550000000' },
    whatsapp_cloud: { access_token: 'EAA', phone_number_id: '999' },
    sms: { twilio_account_sid: 'AC1', twilio_auth_token: 't', phone_number: '+15550000000' },
    imessage_sendblue: { api_key_id: 'k', api_secret_key: 's', phone_number: '+15550000000' },
    imessage_loopmessage: { api_key: 'k', sender_name: 'bot@imsg.example.com' },
    signal: { api_url: 'https://signal.example.com', phone_number: '+15550000000' },
    matrix: { homeserver_url: 'https://matrix.example.org', access_token: 'syt' },
    irc: { webhook_url: 'https://irc-bridge.example.com/send' },
    webhook: { callback_url: 'https://hooks.example.com/in' },
  };

  const seedChannel = (type: string, over: { gateway?: Record<string, any>; channel?: Record<string, any> } = {}) => {
    const gateway = Object.assign(new Gateway(), {
      id: `gw-${type}`,
      type: type as GatewayType,
      status: GatewayStatus.ACTIVE,
      visibility: 'org',
      agentId: agent.id,
      organizationId: 'org-1',
      configuration: { ...CONFIG[type] },
      ...(over.gateway ?? {}),
    });
    gateways.seed(gateway);
    channels.seed(
      Object.assign(new AgentChannel(), {
        id: `ch-${type}`,
        agentId: agent.id,
        organizationId: 'org-1',
        type: type as ChannelType,
        name: `My ${type}`,
        status: ChannelStatus.LIVE,
        gatewayId: gateway.id,
        createdAt: new Date(),
        ...(over.channel ?? {}),
      }),
    );
    return gateway;
  };

  const execution = (output: any = 'Sales were up 4% yesterday.', status = AgentExecutionStatus.COMPLETED) => {
    const row: any = { id: `exec-${Math.random().toString(36).slice(2)}`, agentId: agent.id, organizationId: 'org-1', userId: 'u-1', status, output, metadata: { triggerType: 'scheduled' } };
    executions.seed(row);
    return row;
  };

  const storedDelivery = async (id: string) => (await executions.findOne({ where: { id } }))!.metadata.channelDelivery;

  beforeEach(() => {
    fetchMock = installFetchMock();
    fetchMock.setNextResponse({ ok: true, status: 200, json: { ok: true, access_token: 'tok', id: 'x', messages: [{ id: 'm' }] } });
    gateways = fakeRepository<any>([]);
    channels = fakeRepository<any>([]);
    executions = fakeRepository<any>([]);
    events = fakeRepository<any>([]);
    notifications = { emit: jest.fn(async () => undefined) };
    policies = { forGateway: jest.fn(async () => ({ channel: null })), reachedFor: jest.fn(async () => null) };
    const channelGateway = new ChannelGatewayService(
      gateways as any,
      fakeRepository<any>([]) as any,
      events as any,
      {} as any,
      new ChatWidgetAdapter(null as any),
      slack,
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
      new IMessageSendblueAdapter(),
      new IMessageLoopMessageAdapter(),
    );
    service = new ScheduledPostService(
      channels as any,
      gateways as any,
      executions as any,
      channelGateway,
      slack,
      policies as any,
      notifications as any,
    );
  });

  afterEach(() => fetchMock.restore());

  /** The one request that is not a token exchange. */
  const sendCall = () => fetchMock.calls.filter((c) => !/login\.microsoftonline|oauth2/.test(c.url));

  describe('posts through each platform to the chosen destination', () => {
    it.each([
      ['slack', 'C0123ABCDEF', (c: any) => {
        expect(c.url).toBe('https://slack.com/api/chat.postMessage');
        expect(parseSentJson(c)).toMatchObject({ channel: 'C0123ABCDEF', text: expect.stringContaining('Sales were up') });
        expect(parseSentJson(c).thread_ts).toBeUndefined();
      }],
      ['telegram', '-1001234567890', (c: any) => {
        expect(c.url).toContain('/sendMessage');
        expect(parseSentJson(c)).toMatchObject({ chat_id: '-1001234567890' });
      }],
      ['discord', '123456789012345678', (c: any) => {
        expect(c.url).toBe('https://discord.com/api/v10/channels/123456789012345678/messages');
      }],
      ['google_chat', '', (c: any) => {
        expect(c.url).toContain('chat.googleapis.com/v1/spaces/AAA/messages');
        expect(parseSentJson(c).thread).toBeUndefined();
      }],
      ['whatsapp', '+14155550100', (c: any) => {
        expect(c.url).toContain('api.twilio.com');
        expect(parseSentForm(c).To).toBe('whatsapp:+14155550100');
      }],
      ['whatsapp_cloud', '+14155550100', (c: any) => {
        expect(c.url).toContain('/999/messages');
        expect(parseSentJson(c)).toMatchObject({ to: '14155550100', text: { body: expect.stringContaining('Sales') } });
      }],
      ['sms', '+14155550100', (c: any) => {
        expect(parseSentForm(c)).toMatchObject({ To: '+14155550100', From: '+15550000000' });
      }],
      ['imessage_sendblue', '+14155550100', (c: any) => {
        expect(parseSentJson(c)).toMatchObject({ number: '+14155550100' });
      }],
      ['imessage_loopmessage', '+14155550100', (c: any) => {
        expect(parseSentJson(c)).toMatchObject({ contact: '+14155550100' });
      }],
      ['signal', '+14155550100', (c: any) => {
        expect(c.url).toBe('https://signal.example.com/v2/send');
        expect(parseSentJson(c).recipients).toEqual(['+14155550100']);
      }],
      ['matrix', '!room:example.org', (c: any) => {
        expect(c.url).toContain(`/rooms/${encodeURIComponent('!room:example.org')}/send/m.room.message/`);
      }],
      ['irc', '#team', (c: any) => {
        expect(parseSentJson(c)).toMatchObject({ channel: '#team' });
      }],
      ['webhook', '', (c: any) => {
        expect(c.url).toBe('https://hooks.example.com/in');
      }],
    ])('%s', async (type, to, check) => {
      seedChannel(type);
      const run = execution();
      const delivery = await service.checkDestination(agent, { kind: 'channel', channelId: `ch-${type}`, to });
      const outcome = await service.post(agent, run, delivery);

      expect(outcome.status).toBe('delivered');
      const calls = sendCall();
      expect(calls).toHaveLength(1);
      check(calls[0]);
      expect(await storedDelivery(run.id)).toMatchObject({ status: 'delivered', channelId: `ch-${type}`, parts: 1 });
      // On the channel's activity like any outbound message.
      expect(await events.find({ where: { gatewayId: `gw-${type}`, direction: 'outbound', status: 'processed' } })).toHaveLength(1);
    });

    it('email: to every address, with a subject of its own rather than a "Re:"', async () => {
      seedChannel('email');
      const run = execution();
      const delivery = await service.checkDestination(agent, {
        kind: 'channel',
        channelId: 'ch-email',
        to: 'Team@Example.com, lead@example.com',
      });
      expect(delivery.to).toBe('team@example.com, lead@example.com');
      await service.post(agent, run, delivery, { timezone: 'Europe/Berlin' });

      const [call] = sendCall();
      expect(call.url).toBe('https://api.resend.com/emails');
      const body = parseSentJson(call);
      expect(body.to).toEqual(['team@example.com', 'lead@example.com']);
      expect(body.subject).toMatch(/^Morning report, \w{3} \d{1,2} \w{3,4} \d{4}$/);
      expect(body.headers).toBeUndefined();
    });

    it('microsoft teams: to a conversation the bot has talked in, on its service address', async () => {
      const gateway = seedChannel('microsoft_teams');
      events.seed({
        id: 'ev-1',
        organizationId: 'org-1',
        gatewayId: gateway.id,
        channelType: 'microsoft_teams',
        direction: 'inbound',
        status: 'processed',
        createdAt: new Date(),
        payload: {
          type: 'message',
          text: 'hi',
          from: { id: 'u1', name: 'Ana' },
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          conversation: { id: '19:abc@thread.tacv2', name: 'Sales', conversationType: 'channel' },
          channelId: 'msteams',
        },
      });
      const [option] = await service.destinations(agent);
      expect(option).toMatchObject({ choose: 'pick', destinations: [{ to: '19:abc@thread.tacv2', label: 'Sales' }] });

      const delivery = await service.checkDestination(agent, { kind: 'channel', channelId: 'ch-microsoft_teams', to: '19:abc@thread.tacv2' });
      expect(delivery.context).toEqual({ serviceUrl: 'https://smba.trafficmanager.net/emea/' });
      await service.post(agent, execution(), delivery);
      const [call] = sendCall();
      expect(call.url).toBe('https://smba.trafficmanager.net/emea//v3/conversations/19:abc@thread.tacv2/activities');
    });

    it('microsoft teams: refuses a conversation the bot has never talked in', async () => {
      seedChannel('microsoft_teams');
      await expect(
        service.checkDestination(agent, { kind: 'channel', channelId: 'ch-microsoft_teams', to: '19:unknown' }),
      ).rejects.toThrow(/from the list/);
    });
  });

  it('carries the channel AI disclosure at the top of the post', async () => {
    seedChannel('slack', { gateway: { configuration: { ...CONFIG.slack, aiDisclosure: 'This message was written by an AI.' } } });
    await service.post(agent, execution(), { kind: 'channel', channelId: 'ch-slack', to: 'C0123ABCDEF' });
    expect(parseSentJson(sendCall()[0]).text).toMatch(/^This message was written by an AI\.\n\nSales were up/);
  });

  it('splits a long result into platform-sized messages, in order', async () => {
    seedChannel('discord');
    const paragraphs = Array.from({ length: 6 }, (_v, i) => `Paragraph ${i + 1}. ${'word '.repeat(120)}`.trim());
    const run = execution(paragraphs.join('\n\n'));
    const outcome = await service.post(agent, run, { kind: 'channel', channelId: 'ch-discord', to: '123456789012345678' });
    const calls = sendCall();
    expect(outcome).toMatchObject({ status: 'delivered', parts: calls.length });
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(parseSentJson(c).content.length).toBeLessThanOrEqual(2000);
    expect(parseSentJson(calls[0]).content.startsWith('Paragraph 1.')).toBe(true);
  });

  it('records a refused post on the run and tells the owner', async () => {
    seedChannel('slack');
    fetchMock.setNextResponse({ ok: true, status: 200, json: { ok: false, error: 'not_in_channel' } });
    const run = execution();
    const outcome = await service.post(agent, run, { kind: 'channel', channelId: 'ch-slack', to: 'C0123ABCDEF', label: '#sales' });

    expect(outcome.status).toBe('failed');
    expect(await storedDelivery(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('not_in_channel') });
    expect(await events.find({ where: { gatewayId: 'gw-slack', direction: 'outbound', status: 'failed' } })).toHaveLength(1);
    expect(notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run.failed',
        userIds: ['u-1'],
        title: 'Result not posted: Morning report',
        body: expect.stringContaining('#sales'),
      }),
    );
  });

  it('posts nothing for a run that failed', async () => {
    seedChannel('slack');
    const run = execution(null, AgentExecutionStatus.FAILED);
    const outcome = await service.post(agent, run, { kind: 'channel', channelId: 'ch-slack', to: 'C0123ABCDEF' });
    expect(outcome.status).toBe('skipped');
    expect(fetchMock.calls).toHaveLength(0);
  });

  describe('admit', () => {
    it("refuses when the channel's spend limit is reached", async () => {
      seedChannel('slack');
      policies.reachedFor.mockResolvedValue({ reached: 'day', resetsAt: null });
      await expect(service.admit(agent, { kind: 'channel', channelId: 'ch-slack', to: 'C1' })).resolves.toEqual({
        ok: false,
        reason: 'the My slack channel has reached its spend limit for today',
      });
    });

    it('refuses a channel that is switched off', async () => {
      seedChannel('slack', { gateway: { status: GatewayStatus.INACTIVE } });
      await expect(service.admit(agent, { kind: 'channel', channelId: 'ch-slack', to: 'C1' })).resolves.toMatchObject({ ok: false });
    });

    it('lets a live channel with allowance left through', async () => {
      seedChannel('slack');
      await expect(service.admit(agent, { kind: 'channel', channelId: 'ch-slack', to: 'C1' })).resolves.toEqual({ ok: true });
    });
  });

  describe('checkDestination', () => {
    it("refuses another agent's channel", async () => {
      seedChannel('slack', { channel: { agentId: 'someone-else' } });
      await expect(service.checkDestination(agent, { kind: 'channel', channelId: 'ch-slack', to: 'C0123ABCDEF' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it.each([
      ['slack', '#general'],
      ['email', 'not-an-address'],
      ['sms', '4155550100'],
      ['discord', 'general'],
      ['matrix', 'room'],
    ])('%s refuses %s with a sentence a person can act on', async (type, to) => {
      seedChannel(type);
      await expect(service.checkDestination(agent, { kind: 'channel', channelId: `ch-${type}`, to })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('does not offer the web chat, which has nobody to post to', async () => {
      seedChannel('slack');
      channels.seed(Object.assign(new AgentChannel(), { id: 'ch-web', agentId: agent.id, organizationId: 'org-1', type: ChannelType.WEB, name: 'Web', status: ChannelStatus.LIVE, gatewayId: null, createdAt: new Date() }));
      const options = await service.destinations(agent);
      expect(options.map((o) => o.type)).toEqual(['slack']);
    });
  });
});

describe('splitMessage', () => {
  it('leaves a short result whole', () => {
    expect(splitMessage('hello', 100, 3)).toEqual({ parts: ['hello'], truncated: false });
  });

  it('breaks at paragraph ends when it can', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    expect(splitMessage(text, 100, 3).parts).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
  });

  it('cuts past the last allowed part and says so', () => {
    const { parts, truncated } = splitMessage('word '.repeat(200), 100, 2);
    expect(truncated).toBe(true);
    expect(parts).toHaveLength(2);
    expect(parts[1].endsWith(TRUNCATION_NOTE)).toBe(true);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
  });

  it('keeps one message where the platform has no limit', () => {
    expect(splitMessage('x'.repeat(10000), null, 1).parts).toHaveLength(1);
  });
});

describe('resultText', () => {
  it('reads text, a text field, or indented JSON', () => {
    expect(resultText('plain')).toBe('plain');
    expect(resultText({ text: 'from text' })).toBe('from text');
    expect(resultText({ rows: 2 })).toBe('{\n  "rows": 2\n}');
    expect(resultText(null)).toBe('');
  });
});
