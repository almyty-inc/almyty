import { EventEmitter } from 'events';

import { ChannelGatewayService } from '../channel-gateway.service';
import { ChannelAttachmentReader } from '../channel-attachments.service';
import { shortId } from '../channel-speaker';
import { TextExtractorService } from '../../../files/text-extractor.service';
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
import { IMessageSendblueAdapter } from '../adapters/imessage-sendblue.adapter';
import { IMessageLoopMessageAdapter } from '../adapters/imessage-loopmessage.adapter';
import { BY_ID, ClauseModel, ExecutedQuery, RecordingQueryBuilder, matchingRows, tableUpdates } from '../../__tests__/recording-query-builder';

/**
 * iMessage group chats and files, through the whole inbound pipeline:
 * verification, the per-sender share, the thread lookup, the run, and the
 * reply. The relays are faked at the HTTP boundary (global fetch) with
 * the payloads their docs give; the relay's CDN is faked there too, so
 * the attachment goes through the real guarded client.
 */
const SENDBLUE_SECRET = 'sb-webhook-secret-0001';
const LOOP_TOKEN = 'loop-webhook-auth-0001';

const sendblueGroupMessage = (from: string, handle: string, extra: Record<string, unknown> = {}) => ({
  accountEmail: 'ops@northwind.example',
  content: 'Can someone check order 1182?',
  is_outbound: false,
  status: 'RECEIVED',
  message_handle: handle,
  date_sent: '2026-09-30T10:00:00.000Z',
  from_number: from,
  to_number: '+15122164639',
  sendblue_number: '+15122164639',
  media_url: '',
  group_id: 'b1e9f6d2-group-7731',
  participants: ['+14155550101', '+14155550102', '+15122164639'],
  group_display_name: 'Northwind ops',
  service: 'iMessage',
  ...extra,
});

const loopGroupMessage = (contact: string, id: string, extra: Record<string, unknown> = {}) => ({
  event: 'message_inbound',
  contact,
  text: 'Is this the right mug?',
  message_type: 'text',
  message_id: id,
  webhook_id: `wh-${id}`,
  api_version: '1.0',
  group: { id: '7e0b1f4a-group', name: 'Northwind ops', participants: ['+13231112233', '+13231114455'] },
  ...extra,
});

describe('iMessage groups and attachments through the channel pipeline', () => {
  const originalFetch = globalThis.fetch;
  let relayCalls: Array<{ url: string; body: any }>;
  let cdnCalls: string[];
  let cdn: (url: string) => Response;
  let runs: any[];
  let runRepository: any;
  let eventRepository: any;
  let gatewayRepository: any;
  let agentRuntimeService: any;
  let gatewayRateLimit: { checkVisitor: jest.Mock };
  let emitter: EventEmitter;
  let limitedSenders: Set<string>;

  const gatewayOf = (type: GatewayType, configuration: Record<string, any>): Gateway => {
    const gateway = new Gateway();
    gateway.id = 'gw-imsg';
    gateway.type = type;
    gateway.status = GatewayStatus.ACTIVE;
    gateway.agentId = 'agent-1';
    gateway.organizationId = 'org-1';
    gateway.configuration = configuration;
    return gateway;
  };
  const sendblueGateway = () =>
    gatewayOf(GatewayType.IMESSAGE_SENDBLUE, {
      api_key_id: 'sb-key-id',
      api_secret_key: 'sb-secret-key',
      phone_number: '+15122164639',
      signing_secret: SENDBLUE_SECRET,
    });
  const loopGateway = () =>
    gatewayOf(GatewayType.IMESSAGE_LOOPMESSAGE, { api_key: 'loop-api-key', inbound_token: LOOP_TOKEN, sender_name: 'northwind' });

  const buildService = (withReader = true) =>
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
      new IMessageSendblueAdapter(),
      new IMessageLoopMessageAdapter(),
      undefined,
      undefined,
      gatewayRateLimit as any,
      undefined,
      undefined,
      undefined,
      withReader ? new ChannelAttachmentReader(new TextExtractorService()) : undefined,
    );

  /** The run finishes; the listener sends the reply. */
  const finishRun = async () => {
    emitter.emit('event', { type: 'run.completed' });
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    relayCalls = [];
    cdnCalls = [];
    cdn = () => new Response('', { status: 404 });
    limitedSenders = new Set();
    emitter = new EventEmitter();
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      if (url.startsWith('https://api.sendblue.co/') || url.startsWith('https://a.loopmessage.com/')) {
        relayCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ status: 'QUEUED', message_id: 'OUT-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      cdnCalls.push(url);
      return cdn(url);
    });

    runs = [];
    const RUN_CLAUSES: ClauseModel = {
      'run.agentId = :agentId': (row, p) => row.agentId === p.agentId,
      'run.status IN (:...activeStatuses)': (row, p) => p.activeStatuses.includes(row.status),
      "run.metadata->>'threadId' = :threadId": (row, p) => row.metadata?.threadId === p.threadId,
      "run.metadata->>'gatewayId' = :gatewayId": (row, p) => row.metadata?.gatewayId === p.gatewayId,
    };
    runRepository = {
      createQueryBuilder: jest.fn(
        (alias: string) =>
          new RecordingQueryBuilder(alias, { getMany: (query: ExecutedQuery) => matchingRows(query, runs, RUN_CLAUSES) }),
      ),
      save: jest.fn(async (r: any) => r),
      findOne: jest.fn(async ({ where }: any) => runs.find((r) => r.id === where.id) ?? null),
    };
    eventRepository = {
      rows: [] as any[],
      create: jest.fn((data: any) => data),
      save: jest.fn(async (e: any) => {
        const stored = { id: `evt-${eventRepository.rows.length + 1}`, createdAt: new Date(), ...e };
        eventRepository.rows.push(stored);
        return stored;
      }),
      update: jest.fn(async (where: any, patch: any) => {
        const target = eventRepository.rows.find((r: any) => r.id === where.id);
        if (target) Object.assign(target, patch);
        return { affected: target ? 1 : 0 };
      }),
    };
    const gatewayRows = [{ id: 'gw-imsg', totalRequests: 0, successfulRequests: 0 }];
    gatewayRepository = { createQueryBuilder: tableUpdates(() => gatewayRows, BY_ID).createQueryBuilder };
    agentRuntimeService = {
      startRun: jest.fn(async (agentId: string, _org: string, _user: null, input: string, options: any) => {
        const run = { id: `run-${runs.length + 1}`, agentId, status: 'running', input, metadata: options.metadata, output: 'On it.' };
        runs.push(run);
        return run;
      }),
      sendInput: jest.fn(async (runId: string) => runs.find((r) => r.id === runId)),
      getRunEmitter: jest.fn(() => emitter),
    };
    gatewayRateLimit = {
      checkVisitor: jest.fn(async (_gateway: Gateway, who: { endUserId: string | null }) =>
        limitedSenders.has(String(who.endUserId))
          ? { limited: true, message: 'You have sent too many messages. Try again later.' }
          : { limited: false },
      ),
    };
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  describe('group chats', () => {
    it('Sendblue: a group message starts a run keyed on the group, and the reply goes to the group', async () => {
      const service = buildService();
      await service.handleInboundMessage(sendblueGateway(), sendblueGroupMessage('+14155550101', 'H-1'), {
        'sb-signing-secret': SENDBLUE_SECRET,
      });

      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
      const [, , userId, input, options] = agentRuntimeService.startRun.mock.calls[0];
      expect(userId).toBeNull();
      // In a group each message is read as its writer's. The relay gives a
      // phone number and no name, so a short id stands in, never the number.
      expect(input).toBe(`${shortId('+14155550101')}: Can someone check order 1182?`);
      expect(input).not.toContain('4155550101');
      // The conversation is the group; the member who wrote is recorded.
      expect(options.metadata).toMatchObject({ threadId: 'b1e9f6d2-group-7731', channelUserId: '+14155550101' });

      await finishRun();
      expect(relayCalls).toEqual([
        {
          url: 'https://api.sendblue.co/api/send-group-message',
          body: { group_id: 'b1e9f6d2-group-7731', from_number: '+15122164639', content: 'On it.' },
        },
      ]);
    });

    it('Sendblue: another member in the same group continues the same conversation', async () => {
      const service = buildService();
      await service.handleInboundMessage(sendblueGateway(), sendblueGroupMessage('+14155550101', 'H-1'), {
        'sb-signing-secret': SENDBLUE_SECRET,
      });
      await service.handleInboundMessage(
        sendblueGateway(),
        sendblueGroupMessage('+14155550102', 'H-2', { content: 'It shipped yesterday.' }),
        { 'sb-signing-secret': SENDBLUE_SECRET },
      );

      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
      expect(agentRuntimeService.sendInput).toHaveBeenCalledWith('run-1', 'org-1', `${shortId('+14155550102')}: It shipped yesterday.`, undefined, []);
      // Two members, two names: the agent can tell them apart.
      expect(shortId('+14155550101')).not.toBe(shortId('+14155550102'));
      // The inbound event row keeps who said it.
      const inbound = eventRepository.rows.filter((r: any) => r.direction === 'inbound');
      expect(inbound.map((r: any) => r.payload?.from_number)).toEqual(['+14155550101', '+14155550102']);
    });

    it('Sendblue: a one-to-one message from a group member is its own conversation, not the group', async () => {
      const service = buildService();
      await service.handleInboundMessage(sendblueGateway(), sendblueGroupMessage('+14155550101', 'H-1'), {
        'sb-signing-secret': SENDBLUE_SECRET,
      });
      await service.handleInboundMessage(
        sendblueGateway(),
        sendblueGroupMessage('+14155550101', 'H-3', { group_id: '', participants: [], group_display_name: null }),
        { 'sb-signing-secret': SENDBLUE_SECRET },
      );
      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(2);
      expect(agentRuntimeService.startRun.mock.calls[1][4].metadata.threadId).toBe('+14155550101');
    });

    it('LoopMessage: a group message is answered in the group, from the sender name', async () => {
      const service = buildService();
      await service.handleInboundMessage(loopGateway(), loopGroupMessage('+13231114455', 'L-1'), { authorization: LOOP_TOKEN });

      expect(agentRuntimeService.startRun.mock.calls[0][4].metadata).toMatchObject({
        threadId: '7e0b1f4a-group',
        channelUserId: '+13231114455',
      });
      await finishRun();
      expect(relayCalls).toEqual([
        {
          url: 'https://a.loopmessage.com/api/v1/message/send/',
          body: { group: '7e0b1f4a-group', text: 'On it.', sender: 'northwind' },
        },
      ]);
    });
  });

  describe('visitor limits in a group count per sender', () => {
    it('asks for the share of the member who wrote, never the group', async () => {
      const service = buildService();
      await service.handleInboundMessage(sendblueGateway(), sendblueGroupMessage('+14155550101', 'H-1'), {
        'sb-signing-secret': SENDBLUE_SECRET,
      });
      await service.handleInboundMessage(loopGateway(), loopGroupMessage('+13231114455', 'L-1'), { authorization: LOOP_TOKEN });

      const asked = gatewayRateLimit.checkVisitor.mock.calls.map(([, who]) => who.endUserId);
      expect(asked).toEqual(['+14155550101', '+13231114455']);
      expect(asked).not.toContain('b1e9f6d2-group-7731');
      expect(asked).not.toContain('7e0b1f4a-group');
    });

    it('a member over their limit is turned away while the rest of the group is still answered', async () => {
      limitedSenders.add('+14155550101');
      const service = buildService();

      await service.handleInboundMessage(sendblueGateway(), sendblueGroupMessage('+14155550101', 'H-1'), {
        'sb-signing-secret': SENDBLUE_SECRET,
      });
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
      expect(eventRepository.rows[0]).toMatchObject({ status: 'failed', errorMessage: 'You have sent too many messages. Try again later.' });

      await service.handleInboundMessage(sendblueGateway(), sendblueGroupMessage('+14155550102', 'H-2'), {
        'sb-signing-secret': SENDBLUE_SECRET,
      });
      expect(agentRuntimeService.startRun).toHaveBeenCalledTimes(1);
      expect(agentRuntimeService.startRun.mock.calls[0][4].metadata.channelUserId).toBe('+14155550102');
    });
  });

  describe('inbound attachments', () => {
    it('Sendblue: the photo is fetched through the guarded client and described in the run input', async () => {
      // A real JPEG signature: the bytes, not the link or the header, say what the file is.
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4092, 7)]);
      cdn = () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      const service = buildService();
      await service.handleInboundMessage(
        sendblueGateway(),
        sendblueGroupMessage('+14155550101', 'H-1', {
          content: 'Is this damaged?',
          media_url: 'https://storage.googleapis.com/inbound-file-store/abc/IMG_0042.jpeg',
        }),
        { 'sb-signing-secret': SENDBLUE_SECRET },
      );

      expect(cdnCalls).toEqual(['https://storage.googleapis.com/inbound-file-store/abc/IMG_0042.jpeg']);
      expect(agentRuntimeService.startRun.mock.calls[0][3]).toBe(
        `${shortId('+14155550101')}: Is this damaged?\n\n[Attachment: IMG_0042.jpeg (image/jpeg, 4 KB)]`,
      );
    });

    it('LoopMessage: a text file sent without a message reaches the agent as its text', async () => {
      cdn = () => new Response('Order 1182: two blue mugs', { status: 200, headers: { 'content-type': 'text/plain' } });
      const service = buildService();
      await service.handleInboundMessage(
        loopGateway(),
        loopGroupMessage('+13231114455', 'L-1', { text: '', attachments: ['https://cdn.loopmessage.com/att/order.txt'] }),
        { authorization: LOOP_TOKEN },
      );
      expect(agentRuntimeService.startRun.mock.calls[0][3]).toBe(
        `${shortId('+13231114455')}: [Attachment: order.txt (text/plain, 25 B)]\nOrder 1182: two blue mugs`,
      );
    });

    it('a link to an internal address is never dialled; the agent is told the file was not read', async () => {
      const service = buildService();
      await service.handleInboundMessage(
        loopGateway(),
        loopGroupMessage('+13231114455', 'L-1', { attachments: ['https://169.254.169.254/latest/meta-data.png'] }),
        { authorization: LOOP_TOKEN },
      );
      expect(cdnCalls).toEqual([]);
      expect(agentRuntimeService.startRun.mock.calls[0][3]).toBe(
        `${shortId('+13231114455')}: Is this the right mug?\n\n[Attachment: meta-data.png was not read: its address is not allowed]`,
      );
    });

    it('a file over the size cap is not read', async () => {
      cdn = () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'video/quicktime', 'content-length': String(ChannelAttachmentReader.MAX_BYTES + 1) },
        });
      const service = buildService();
      await service.handleInboundMessage(
        sendblueGateway(),
        sendblueGroupMessage('+14155550101', 'H-1', { content: '', media_url: 'https://cdn.example/clip.mov' }),
        { 'sb-signing-secret': SENDBLUE_SECRET },
      );
      expect(agentRuntimeService.startRun.mock.calls[0][3]).toBe(`${shortId('+14155550101')}: [Attachment: clip.mov was not read: it is larger than 10 MB]`);
    });

    it('a limited sender costs no download', async () => {
      limitedSenders.add('+14155550101');
      const service = buildService();
      await service.handleInboundMessage(
        sendblueGateway(),
        sendblueGroupMessage('+14155550101', 'H-1', { media_url: 'https://cdn.example/a.jpg' }),
        { 'sb-signing-secret': SENDBLUE_SECRET },
      );
      expect(cdnCalls).toEqual([]);
    });

    it('Signal: an attachment is read by id from the configured bridge, through the egress guard', async () => {
      const service = buildService();
      const signal = gatewayOf(GatewayType.SIGNAL, { api_url: 'https://signal-bridge.example', phone_number: '+1', inbound_token: 'signal-token-000001' });
      await service.handleInboundMessage(
        signal,
        {
          envelope: {
            source: '+14155550199',
            timestamp: 1,
            dataMessage: { message: 'see attached', attachments: [{ id: 'att1', contentType: 'image/png', filename: 'a.png' }] },
          },
        },
        { authorization: 'Bearer signal-token-000001' },
      );
      expect(cdnCalls).toEqual(['https://signal-bridge.example/v1/attachments/att1']);
      // The bridge answered 404 here: the agent is told, and the message still goes through.
      expect(agentRuntimeService.startRun.mock.calls[0][3]).toBe('see attached\n\n[Attachment: a.png was not read: it could not be fetched]');
    });
  });

  describe('outbound files', () => {
    it('files a run hands back go out as the relay\'s media field', async () => {
      const service = buildService();
      await service.handleInboundMessage(sendblueGateway(), sendblueGroupMessage('+14155550101', 'H-1'), {
        'sb-signing-secret': SENDBLUE_SECRET,
      });
      runs[0].output = {
        text: 'Here is the label.',
        attachments: [{ url: 'https://files.northwind.example/label-1182.png', type: 'image/png', name: 'label-1182.png' }],
      };
      await finishRun();
      expect(relayCalls[0].body).toEqual({
        group_id: 'b1e9f6d2-group-7731',
        from_number: '+15122164639',
        content: 'Here is the label.',
        media_url: 'https://files.northwind.example/label-1182.png',
      });
    });
  });
});
