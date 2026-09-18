import { ChatWidgetAdapter } from '../chat-widget.adapter';
import { SlackAdapter } from '../slack.adapter';
import { DiscordAdapter } from '../discord.adapter';
import { TelegramAdapter } from '../telegram.adapter';
import { WhatsAppAdapter } from '../whatsapp.adapter';
import { WhatsAppCloudAdapter } from '../whatsapp-cloud.adapter';
import { SmsAdapter } from '../sms.adapter';
import { EmailAdapter } from '../email.adapter';
import { WebhookAdapter } from '../webhook.adapter';
import { GoogleChatAdapter } from '../google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../microsoft-teams.adapter';
import { SignalAdapter } from '../signal.adapter';
import { MatrixAdapter } from '../matrix.adapter';
import { IrcAdapter } from '../irc.adapter';
import { BaseAdapter } from '../base.adapter';

/**
 * `deliveryId` is what stops a platform's redelivery from becoming a
 * second agent run. Two properties matter, and a wrong answer to either
 * is worse than no answer:
 *
 *   - STABLE: two deliveries of the same platform message must produce
 *     the same key, or the dedupe silently does nothing.
 *   - DISTINCT: two different messages must not collide, or a real
 *     message is dropped and the user never gets a reply.
 *
 * The channels with nothing stable to key on are listed explicitly
 * below, so the gap is a recorded fact rather than an oversight.
 */
describe('adapter deliveryId', () => {
  /** Adapter, a payload, the same payload redelivered, a different message. */
  const cases: Array<{
    name: string;
    adapter: BaseAdapter;
    payload: any;
    other: any;
    headers?: Record<string, string>;
  }> = [
    {
      name: 'slack (event_id)',
      adapter: new SlackAdapter(),
      payload: { event_id: 'Ev123', event: { channel: 'C1', ts: '1.1', text: 'a', user: 'U1' } },
      other: { event_id: 'Ev999', event: { channel: 'C1', ts: '2.2', text: 'b', user: 'U1' } },
    },
    {
      name: 'discord (message snowflake)',
      adapter: new DiscordAdapter(),
      payload: { id: '900', content: 'a', author: { id: 'U1' }, channel_id: 'C1' },
      other: { id: '901', content: 'b', author: { id: 'U1' }, channel_id: 'C1' },
    },
    {
      name: 'telegram (update_id)',
      adapter: new TelegramAdapter(),
      payload: { update_id: 55, message: { message_id: 7, chat: { id: 9 }, text: 'a' } },
      other: { update_id: 56, message: { message_id: 8, chat: { id: 9 }, text: 'b' } },
    },
    {
      name: 'whatsapp via twilio (MessageSid)',
      adapter: new WhatsAppAdapter(),
      payload: { MessageSid: 'SM1', Body: 'a', From: 'whatsapp:+1' },
      other: { MessageSid: 'SM2', Body: 'b', From: 'whatsapp:+1' },
    },
    {
      name: 'whatsapp cloud (wamid)',
      adapter: new WhatsAppCloudAdapter(),
      payload: {
        entry: [{ changes: [{ value: { messages: [{ id: 'wamid.A', from: '1', text: { body: 'a' } }] } }] }],
      },
      other: {
        entry: [{ changes: [{ value: { messages: [{ id: 'wamid.B', from: '1', text: { body: 'b' } }] } }] }],
      },
    },
    {
      name: 'sms via twilio (MessageSid)',
      adapter: new SmsAdapter(),
      payload: { MessageSid: 'SM1', Body: 'a', From: '+1' },
      other: { MessageSid: 'SM2', Body: 'b', From: '+1' },
    },
    {
      name: 'email (Message-ID)',
      adapter: new EmailAdapter(),
      payload: { messageId: '<a@example>', text: 'a', from: 'x@example', subject: 's' },
      other: { messageId: '<b@example>', text: 'b', from: 'x@example', subject: 's' },
    },
    {
      name: 'google chat (message resource name)',
      adapter: new GoogleChatAdapter(),
      payload: { message: { name: 'spaces/S/messages/A', text: 'a', sender: { name: 'u' } } },
      other: { message: { name: 'spaces/S/messages/B', text: 'b', sender: { name: 'u' } } },
    },
    {
      name: 'microsoft teams (activity id)',
      adapter: new MicrosoftTeamsAdapter(),
      payload: { id: 'act-A', text: 'a', from: { id: 'u' }, conversation: { id: 'c' } },
      other: { id: 'act-B', text: 'b', from: { id: 'u' }, conversation: { id: 'c' } },
    },
    {
      name: 'matrix (event id)',
      adapter: new MatrixAdapter(),
      payload: { event_id: '$A', room_id: '!r', sender: '@u', content: { body: 'a' } },
      other: { event_id: '$B', room_id: '!r', sender: '@u', content: { body: 'b' } },
    },
    {
      name: 'signal (sender + send timestamp)',
      adapter: new SignalAdapter(),
      payload: { envelope: { source: '+1', timestamp: 1000, dataMessage: { message: 'a', timestamp: 1000 } } },
      other: { envelope: { source: '+1', timestamp: 2000, dataMessage: { message: 'b', timestamp: 2000 } } },
    },
    {
      name: 'webhook (sender-supplied id)',
      adapter: new WebhookAdapter(),
      payload: { text: 'a', deliveryId: 'd-1' },
      other: { text: 'b', deliveryId: 'd-2' },
    },
  ];

  for (const { name, adapter, payload, other, headers } of cases) {
    describe(name, () => {
      it('is the same key on a redelivery of the same message', () => {
        const first = adapter.deliveryId(payload, headers);
        const second = adapter.deliveryId(JSON.parse(JSON.stringify(payload)), headers);
        expect(first).toBeTruthy();
        expect(second).toBe(first);
      });

      it('is a different key for a different message', () => {
        expect(adapter.deliveryId(other, headers)).not.toBe(adapter.deliveryId(payload, headers));
      });
    });
  }

  it('email prefers the svix delivery id over the Message-ID', () => {
    const adapter = new EmailAdapter();
    const payload = { messageId: '<a@example>', text: 'a', from: 'x@example' };
    expect(adapter.deliveryId(payload, { 'svix-id': 'msg_1' })).toBe('email:svix:msg_1');
  });

  /**
   * Channels whose inbound payload carries nothing stable. Recorded as a
   * test so the list cannot quietly grow, and so nobody "fixes" it by
   * synthesizing a key from the clock — a key that differs between two
   * deliveries of one message looks like a guarantee and is not one.
   */
  describe('channels with no stable delivery id', () => {
    it('irc bridge payloads carry none', () => {
      expect(new IrcAdapter().deliveryId({ text: 'a', nick: 'n', channel: '#c' })).toBeUndefined();
    });

    it('the chat widget carries none (a direct call, not a retried webhook)', () => {
      expect(new ChatWidgetAdapter(null as any).deliveryId({ message: 'a', sessionId: 's' })).toBeUndefined();
    });

    it('a generic webhook with no id from the sender carries none', () => {
      expect(new WebhookAdapter().deliveryId({ text: 'a' })).toBeUndefined();
    });

    it('a raw-MIME email forward with no Message-ID carries none', () => {
      expect(new EmailAdapter().deliveryId({ text: 'a', from: 'x@example' })).toBeUndefined();
    });

    it('a signal envelope with no sender carries none', () => {
      expect(new SignalAdapter().deliveryId({ envelope: { timestamp: 1 } })).toBeUndefined();
    });
  });

  it('the base default is undefined, so a new adapter opts in rather than guessing', () => {
    class Bare extends BaseAdapter {
      readonly type = 'bare';
      normalizeInbound() { return { text: '', userId: 'u' }; }
      formatOutbound(r: any) { return r; }
      async sendResponse() { /* no-op */ }
    }
    expect(new Bare().deliveryId({ anything: true })).toBeUndefined();
  });
});
