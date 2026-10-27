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
import { IMessageSendblueAdapter } from '../adapters/imessage-sendblue.adapter';
import { IMessageLoopMessageAdapter } from '../adapters/imessage-loopmessage.adapter';
import { installFetchMock, parseSentJson } from '../adapters/__tests__/test-helpers';

/**
 * A button pressed under an approval, through the inbound pipeline: the
 * delivery is verified like any message, claimed by its delivery id so a
 * redelivery is answered once, decided by Always on (never a run), and
 * answered by the adapter. A press that fails verification decides nothing.
 */
const SECRET = 'telegram-secret-token';

describe('inbound pipeline: a button press', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  let events: any[];
  let alwaysOn: { routeInbound: jest.Mock; decideFromChannel: jest.Mock };
  let runtime: { startRun: jest.Mock; sendInput: jest.Mock };

  const gateway = () => {
    const g = new Gateway();
    g.id = 'gw-tg';
    g.type = GatewayType.TELEGRAM;
    g.status = GatewayStatus.ACTIVE;
    g.agentId = 'agent-1';
    g.organizationId = 'org-1';
    g.configuration = { bot_token: 'T', webhook_secret_token: SECRET };
    return g;
  };

  const update = (updateId = 901) => ({
    update_id: updateId,
    callback_query: { id: 'cbq-1', from: { id: 555 }, data: 'apv:a:some-approval', message: { message_id: 7, chat: { id: 555, type: 'private' } } },
  });

  const service = () =>
    new ChannelGatewayService(
      { createQueryBuilder: jest.fn(() => ({ update: () => ({ set: () => ({ where: () => ({ execute: async () => ({}) }) }) }) })) } as any,
      { findOne: jest.fn(), save: jest.fn() } as any,
      {
        create: (e: any) => e,
        save: jest.fn(async (e: any) => {
          if (e.deliveryId && events.some((r) => r.gatewayId === e.gatewayId && r.deliveryId === e.deliveryId)) {
            const err: any = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            throw err;
          }
          const row = { id: `evt-${events.length + 1}`, createdAt: new Date(), ...e };
          events.push(row);
          return row;
        }),
        update: jest.fn(async (where: any, patch: any) => {
          const row = events.find((r) => (where.id ? r.id === where.id : r.deliveryId === where.deliveryId));
          if (row) Object.assign(row, patch);
          return { affected: row ? 1 : 0 };
        }),
        findOne: jest.fn(async (opts: any) => events.find((r) => r.deliveryId === opts?.where?.deliveryId) ?? null),
        createQueryBuilder: jest.fn(() => ({
          update: () => ({ set: () => ({ where: () => ({ andWhere: () => ({ andWhere: () => ({ andWhere: () => ({ execute: async () => ({ affected: 0 }) }) }) }) }) }) }),
        })),
      } as any,
      runtime as any,
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      alwaysOn as any,
    );

  beforeEach(() => {
    fetchMock = installFetchMock();
    fetchMock.setNextResponse({ json: { ok: true, result: {} } });
    events = [];
    alwaysOn = {
      routeInbound: jest.fn(async () => 'continue'),
      decideFromChannel: jest.fn(async () => ({ text: 'Approved. It carries on.', settled: true })),
    };
    runtime = { startRun: jest.fn(), sendInput: jest.fn() };
  });
  afterEach(() => fetchMock.restore());

  it('decides a verified press as the platform\'s user who pressed it, answers it, and starts no run', async () => {
    await service().handleInboundMessage(gateway(), update(), { 'x-telegram-bot-api-secret-token': SECRET });
    expect(alwaysOn.decideFromChannel).toHaveBeenCalledWith({
      organizationId: 'org-1',
      agentId: 'agent-1',
      gatewayId: 'gw-tg',
      senderId: '555',
      data: 'apv:a:some-approval',
    });
    expect(fetchMock.calls.map((c) => c.url.split('/').pop())).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup', 'sendMessage']);
    expect(parseSentJson(fetchMock.calls[2])).toEqual({ chat_id: 555, text: 'Approved. It carries on.' });
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(alwaysOn.routeInbound).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ direction: 'inbound', status: 'processed', deliveryId: 'telegram:901', senderId: '555' });
  });

  it('decides nothing for a press that fails verification', async () => {
    await service().handleInboundMessage(gateway(), update(), { 'x-telegram-bot-api-secret-token': 'forged' });
    expect(alwaysOn.decideFromChannel).not.toHaveBeenCalled();
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('answers a redelivered press once', async () => {
    const svc = service();
    await svc.handleInboundMessage(gateway(), update(902), { 'x-telegram-bot-api-secret-token': SECRET });
    await svc.handleInboundMessage(gateway(), update(902), { 'x-telegram-bot-api-secret-token': SECRET });
    expect(alwaysOn.decideFromChannel).toHaveBeenCalledTimes(1);
  });

  it('records a button it does not know as failed and answers nothing', async () => {
    alwaysOn.decideFromChannel.mockResolvedValueOnce(null);
    await service().handleInboundMessage(gateway(), update(903), { 'x-telegram-bot-api-secret-token': SECRET });
    expect(fetchMock.calls).toHaveLength(0);
    expect(events[0]).toMatchObject({ status: 'failed' });
  });

  it('hands a message its conversation and a way to answer it, for a "yes" in chat', async () => {
    alwaysOn.routeInbound.mockResolvedValueOnce('consumed');
    await service().handleInboundMessage(
      gateway(),
      { update_id: 904, message: { message_id: 9, text: 'yes', from: { id: 555 }, chat: { id: 555, type: 'private' }, reply_to_message: { text: '(ref 3F9A1C)' } } },
      { 'x-telegram-bot-api-secret-token': SECRET },
    );
    const msg = alwaysOn.routeInbound.mock.calls[0][0];
    expect(msg).toMatchObject({ senderId: '555', text: 'yes', replyToText: '(ref 3F9A1C)', group: false, conversation: { to: '555' } });
    await msg.reply('Approved. It carries on.');
    expect(parseSentJson(fetchMock.calls[fetchMock.calls.length - 1])).toEqual({ chat_id: 555, text: 'Approved. It carries on.' });
  });
});
