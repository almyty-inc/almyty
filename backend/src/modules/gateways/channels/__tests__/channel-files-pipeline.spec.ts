import { EventEmitter } from 'events';
import { createHmac } from 'crypto';
import { NotFoundException } from '@nestjs/common';

import { ChannelGatewayService } from '../channel-gateway.service';
import { ChannelAttachmentReader } from '../channel-attachments.service';
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
 * Files and names through the whole channel pipeline: a Slack message in a
 * channel with a file in it, verified, its writer named, the file fetched
 * with the bot token and stored, the run started with a reference to it,
 * the stored file filed under the run's conversation, and the reply's
 * image sent as an image block. Slack is faked at global fetch; the files
 * module is a fake that keeps what it is given.
 */
const SIGNING_SECRET = 'multimodal-signing-secret';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function filesDouble() {
  const stored: any[] = [];
  return {
    stored,
    storeBytes: jest.fn(async (_org: string, bytes: Buffer, file: any, options: any) => {
      stored.push({ bytes, file, options });
      return { id: `file-${stored.length}`, name: file.name, mimeType: file.mimeType, size: bytes.length };
    }),
    attachToConversation: jest.fn(async () => undefined),
    removeMany: jest.fn(async () => 0),
    removeForConversations: jest.fn(async () => 0),
    removeUnsentUploads: jest.fn(async () => 0),
  };
}

describe('files and names through the channel pipeline', () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<{ url: string; init: any }>;
  let runs: any[];
  let emitter: EventEmitter;
  let agentRuntimeService: any;
  let files: ReturnType<typeof filesDouble>;
  let eventRepository: any;

  const slackGateway = () =>
    Object.assign(new Gateway(), {
      id: 'gw-slack',
      type: GatewayType.SLACK,
      status: GatewayStatus.ACTIVE,
      agentId: '00000000-0000-4000-8000-00000000a9e1',
      organizationId: 'org-1',
      configuration: { bot_token: 'xoxb-1', signing_secret: SIGNING_SECRET },
    });
  const widgetGateway = () => Object.assign(slackGateway(), { id: 'gw-widget', type: GatewayType.CHAT_WIDGET, configuration: {} });

  const signed = (payload: unknown) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': 'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${JSON.stringify(payload)}`).digest('hex'),
    };
  };

  const build = () => {
    const RUN_CLAUSES: ClauseModel = {
      'run.agentId = :agentId': (row, p) => row.agentId === p.agentId,
      'run.organizationId = :organizationId': (row, p) => row.organizationId === p.organizationId,
      'run.status IN (:...activeStatuses)': (row, p) => p.activeStatuses.includes(row.status),
      "run.metadata->>'threadId' = :threadId": (row, p) => row.metadata?.threadId === p.threadId,
      "run.metadata->>'gatewayId' = :gatewayId": (row, p) => row.metadata?.gatewayId === p.gatewayId,
    };
    const runRepository = {
      createQueryBuilder: jest.fn((alias: string) => new RecordingQueryBuilder(alias, { getMany: (q: ExecutedQuery) => matchingRows(q, runs, RUN_CLAUSES) })),
      save: jest.fn(async (r: any) => r),
      findOne: jest.fn(async ({ where }: any) => runs.find((r) => r.id === where.id) ?? null),
      delete: jest.fn(async () => ({ affected: 0 })),
      manager: { getRepository: () => ({ delete: jest.fn(async () => ({ affected: 0 })) }) },
    };
    eventRepository = {
      rows: [] as any[],
      create: jest.fn((d: any) => d),
      save: jest.fn(async (e: any) => {
        const row = { id: `evt-${eventRepository.rows.length + 1}`, createdAt: new Date(), ...e };
        eventRepository.rows.push(row);
        return row;
      }),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(() => ({
        delete: () => ({ from: () => ({ where: () => ({ andWhere: () => ({ execute: async () => ({ affected: 0 }) }) }) }) }),
      })),
    };
    const gatewayRows = [{ id: 'gw-slack', totalRequests: 0, successfulRequests: 0 }, { id: 'gw-widget', totalRequests: 0, successfulRequests: 0 }];
    return new ChannelGatewayService(
      { createQueryBuilder: tableUpdates(() => gatewayRows, BY_ID).createQueryBuilder } as any,
      runRepository as any,
      eventRepository,
      agentRuntimeService,
      new ChatWidgetAdapter(eventRepository),
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
      { checkVisitor: async () => ({ limited: false }) } as any,
      undefined,
      undefined,
      undefined,
      new ChannelAttachmentReader(new TextExtractorService(), files as any),
    );
  };

  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    calls = [];
    runs = [];
    emitter = new EventEmitter();
    files = filesDouble();
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://slack.com/api/users.info')) {
        return new Response(JSON.stringify({ ok: true, user: { profile: { display_name: 'Anna' } } }), { headers: { 'content-type': 'application/json' } });
      }
      if (String(url).startsWith('https://files.slack.com/')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      if (String(url) === 'https://slack.com/api/chat.postMessage') {
        return new Response(JSON.stringify({ ok: true, ts: '9.9' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    });
    agentRuntimeService = {
      startRun: jest.fn(async (agentId: string, organizationId: string, _u: null, input: string, options: any) => {
        const run = { id: `run-${runs.length + 1}`, agentId, organizationId, status: 'running', conversationId: `conv-${runs.length + 1}`, input, metadata: options.metadata, output: 'On it.' };
        runs.push(run);
        return run;
      }),
      sendInput: jest.fn(async (runId: string) => runs.find((r) => r.id === runId)),
      getRunEmitter: jest.fn(() => emitter),
    };
  });
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  const slackMessage = {
    team_id: 'T1',
    event_id: 'Ev1',
    event: {
      type: 'message',
      user: 'U1',
      text: 'Is this box damaged?',
      channel: 'C1',
      channel_type: 'channel',
      ts: '100.1',
      files: [{ name: 'box.png', mimetype: 'image/png', size: PNG.length, url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/box.png' }],
    },
  };

  it('names the writer, stores the file and starts the run with a reference to it, filed under its conversation', async () => {
    const service = build();
    await service.handleInboundMessage(slackGateway(), slackMessage, signed(slackMessage));

    const [, , , input, options] = agentRuntimeService.startRun.mock.calls[0];
    expect(input).toBe(`Anna: Is this box damaged?\n\n[Attachment: box.png (image/png, 72 B)]`);
    expect(options.attachments).toEqual([{ type: 'file', fileId: 'file-1', mimeType: 'image/png', name: 'box.png', size: PNG.length }]);
    // The file was read with the bot token, from Slack's file host.
    const fileCall = calls.find((c) => c.url.startsWith('https://files.slack.com/'))!;
    expect(new Headers(fileCall.init.headers).get('authorization')).toBe('Bearer xoxb-1');
    expect(files.stored[0].options.metadata).toMatchObject({ source: 'channel_attachment', channel: 'slack', gatewayId: 'gw-slack', threadId: '100.1' });
    // Filed under the run's conversation, which retention and erasure follow.
    expect(files.attachToConversation).toHaveBeenCalledWith('org-1', ['file-1'], 'conv-1', 'run-1');
  });

  it('removes the stored file when no run will read it', async () => {
    agentRuntimeService.startRun.mockRejectedValueOnce(new NotFoundException('not in scope'));
    const service = build();
    await service.handleInboundMessage(slackGateway(), slackMessage, signed(slackMessage));
    expect(files.removeMany).toHaveBeenCalledWith('org-1', ['file-1']);
    expect(files.attachToConversation).not.toHaveBeenCalled();
  });

  it('sends the reply\'s image as media and takes its link out of the text', async () => {
    const service = build();
    await service.handleInboundMessage(slackGateway(), slackMessage, signed(slackMessage));
    runs[0].output = 'Yes: see ![the dent](https://files.example/dent.png) on the corner.';
    emitter.emit('event', { type: 'run.completed' });
    await settle();

    const post = calls.find((c) => c.url === 'https://slack.com/api/chat.postMessage')!;
    const body = JSON.parse(post.init.body);
    expect(body.text).toBe('Yes: see on the corner.');
    expect(body.blocks.at(-1)).toEqual({ type: 'image', image_url: 'https://files.example/dent.png', alt_text: 'the dent' });
  });

  it('a widget message carries its uploads by reference and files them under the conversation', async () => {
    const service = build();
    const sent = ChannelAttachmentReader.fromFiles([{ id: 'up-1', name: 'receipt.pdf', mimeType: 'application/pdf', size: 2048, extractedText: null as any }]);
    await service.handleWidgetMessage(widgetGateway(), { message: 'Refund this?', threadId: 'wt-1' }, null, sent);
    const [, , , input, options] = agentRuntimeService.startRun.mock.calls[0];
    expect(input).toBe('Refund this?\n\n[Attachment: receipt.pdf (application/pdf, 2 KB)]');
    expect(options.attachments).toEqual([{ type: 'file', fileId: 'up-1', mimeType: 'application/pdf', name: 'receipt.pdf', size: 2048 }]);
    expect(files.attachToConversation).toHaveBeenCalledWith('org-1', ['up-1'], 'conv-1', 'run-1');
  });

  it('erasing a widget thread goes through the shared visitor-data scope, found by that thread', async () => {
    // What the scope reaches (files sent in the thread, uploads not sent,
    // memories, runs) is proven against Postgres in
    // test/integration/visitor-data.integration.spec.ts.
    const service = build();
    const footprint = { organizationId: 'org-1', gatewayIds: ['gw-widget'], endUserIds: [], runIds: ['run-9'], conversationIds: ['conv-9'], widgetThreads: [{ gatewayId: 'gw-widget', threadId: 'wt-9' }] };
    const visitorData = {
      forWidgetThread: jest.fn(async () => footprint),
      erase: jest.fn(async () => ({ runs: 1 })),
    };
    (service as any).visitorData = visitorData;
    await service.deleteWidgetThread(widgetGateway(), 'wt-9');
    expect(visitorData.forWidgetThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'gw-widget' }), 'wt-9');
    expect(visitorData.erase).toHaveBeenCalledWith(footprint, expect.any(Function));
  });
});
