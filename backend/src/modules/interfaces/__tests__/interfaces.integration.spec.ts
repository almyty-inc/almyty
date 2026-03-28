import * as crypto from 'crypto';
import { SlackAdapter } from '../adapters/slack.adapter';
import { DiscordAdapter } from '../adapters/discord.adapter';
import { WebhookAdapter } from '../adapters/webhook.adapter';
import { ChatWidgetAdapter } from '../adapters/chat-widget.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { TelegramAdapter } from '../adapters/telegram.adapter';

/**
 * Integration tests for interface adapters.
 *
 * Tests REAL adapter logic: message normalization, signature verification,
 * response formatting, and edge cases. No mocks needed -- these are pure
 * logic tests on the adapter classes.
 */
describe('Interface Adapters (integration)', () => {
  describe('SlackAdapter', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter();
    });

    it('should have type "slack"', () => {
      expect(adapter.type).toBe('slack');
    });

    describe('normalizeInbound', () => {
      it('should extract fields from a real Slack event payload', () => {
        const payload = {
          event: {
            type: 'message',
            text: 'Hello bot, how are you?',
            user: 'U1234ABCD',
            channel: 'C5678EFGH',
            ts: '1616461234.000100',
            thread_ts: '1616461200.000050',
          },
        };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.text).toBe('Hello bot, how are you?');
        expect(msg.userId).toBe('U1234ABCD');
        expect(msg.threadId).toBe('1616461200.000050'); // uses thread_ts
        expect(msg.metadata?.channel).toBe('C5678EFGH');
        expect(msg.metadata?.ts).toBe('1616461234.000100');
        expect(msg.metadata?.source).toBe('slack');
      });

      it('should handle payload without event wrapper', () => {
        const payload = {
          text: 'Direct message',
          user: 'U9999',
          channel: 'D1111',
          ts: '1616461234.000200',
        };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.text).toBe('Direct message');
        expect(msg.userId).toBe('U9999');
        expect(msg.threadId).toBe('1616461234.000200'); // falls back to ts
      });

      it('should handle missing text and user gracefully', () => {
        const payload = { event: {} };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.text).toBe('');
        expect(msg.userId).toBe('unknown');
      });
    });

    describe('verifyWebhook', () => {
      const signingSecret = 'test_signing_secret_abc123';

      it('should verify a valid Slack signature', async () => {
        const timestamp = '1616461234';
        const payload = { event: { text: 'hello' } };
        const sigBasestring = `v0:${timestamp}:${JSON.stringify(payload)}`;
        const signature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

        const result = await adapter.verifyWebhook(
          payload,
          { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
          { signing_secret: signingSecret },
        );

        expect(result).toBe(true);
      });

      it('should reject an invalid Slack signature (matching length)', async () => {
        const timestamp = '1616461234';
        const payload = { event: { text: 'hello' } };
        // Compute the real signature to know the correct length, then corrupt it
        const sigBasestring = `v0:${timestamp}:${JSON.stringify(payload)}`;
        const realSig = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');
        // Flip one character to make it invalid but same length
        const badSig = realSig.slice(0, -1) + (realSig.slice(-1) === '0' ? '1' : '0');

        const result = await adapter.verifyWebhook(
          payload,
          { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': badSig },
          { signing_secret: signingSecret },
        );

        expect(result).toBe(false);
      });

      it('should throw on signature length mismatch (timingSafeEqual behavior)', async () => {
        const timestamp = '1616461234';
        const payload = { event: { text: 'hello' } };

        // A signature with wrong length causes timingSafeEqual to throw RangeError
        let threw = false;
        try {
          await adapter.verifyWebhook(
            payload,
            { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=short' },
            { signing_secret: signingSecret },
          );
        } catch (err: any) {
          threw = true;
          expect(err.name).toBe('RangeError');
          expect(err.message).toContain('same byte length');
        }
        expect(threw).toBe(true);
      });

      it('should reject when timestamp header is missing', async () => {
        const result = await adapter.verifyWebhook(
          { event: {} },
          { 'x-slack-signature': 'v0=abc' },
          { signing_secret: signingSecret },
        );

        expect(result).toBe(false);
      });

      it('should reject when signature header is missing', async () => {
        const result = await adapter.verifyWebhook(
          { event: {} },
          { 'x-slack-request-timestamp': '12345' },
          { signing_secret: signingSecret },
        );

        expect(result).toBe(false);
      });

      it('should return true when no signing_secret configured (skips verification)', async () => {
        const result = await adapter.verifyWebhook(
          { event: {} },
          {},
          {},
        );

        expect(result).toBe(true);
      });
    });

    describe('formatOutbound', () => {
      it('should format outbound as text field', () => {
        const result = adapter.formatOutbound({ text: 'Response text' });
        expect(result).toEqual({ text: 'Response text' });
      });
    });
  });

  describe('DiscordAdapter', () => {
    let adapter: DiscordAdapter;

    beforeEach(() => {
      adapter = new DiscordAdapter();
    });

    it('should have type "discord"', () => {
      expect(adapter.type).toBe('discord');
    });

    describe('normalizeInbound', () => {
      it('should extract fields from a real Discord message payload', () => {
        const payload = {
          content: 'Hey bot, do something!',
          author: { id: '123456789', username: 'testuser' },
          channel_id: '987654321',
          guild_id: '111222333',
          id: '444555666',
        };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.text).toBe('Hey bot, do something!');
        expect(msg.userId).toBe('123456789');
        expect(msg.threadId).toBe('987654321');
        expect(msg.metadata?.guildId).toBe('111222333');
        expect(msg.metadata?.channelId).toBe('987654321');
        expect(msg.metadata?.source).toBe('discord');
      });

      it('should handle missing author gracefully', () => {
        const payload = { content: 'no author', channel_id: 'ch-1' };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.userId).toBe('unknown');
      });
    });

    describe('formatOutbound', () => {
      it('should truncate text to 2000 chars (Discord limit)', () => {
        const longText = 'A'.repeat(3000);
        const result = adapter.formatOutbound({ text: longText });

        expect(result.content.length).toBe(2000);
        expect(result.content).toBe('A'.repeat(2000));
      });

      it('should pass through text under 2000 chars unchanged', () => {
        const result = adapter.formatOutbound({ text: 'Short message' });
        expect(result.content).toBe('Short message');
      });
    });
  });

  describe('WebhookAdapter', () => {
    let adapter: WebhookAdapter;

    beforeEach(() => {
      adapter = new WebhookAdapter();
    });

    it('should have type "webhook"', () => {
      expect(adapter.type).toBe('webhook');
    });

    describe('normalizeInbound', () => {
      it('should extract text from "text" field', () => {
        const msg = adapter.normalizeInbound({ text: 'hello', userId: 'u1', threadId: 't1' });
        expect(msg.text).toBe('hello');
        expect(msg.userId).toBe('u1');
        expect(msg.threadId).toBe('t1');
      });

      it('should fall back to "message" field', () => {
        const msg = adapter.normalizeInbound({ message: 'fallback message' });
        expect(msg.text).toBe('fallback message');
      });

      it('should fall back to "input" field', () => {
        const msg = adapter.normalizeInbound({ input: 'input text' });
        expect(msg.text).toBe('input text');
      });

      it('should JSON stringify unknown payloads', () => {
        const msg = adapter.normalizeInbound({ custom: 'data', num: 42 });
        expect(msg.text).toBe(JSON.stringify({ custom: 'data', num: 42 }));
      });

      it('should default userId to "webhook"', () => {
        const msg = adapter.normalizeInbound({ text: 'hi' });
        expect(msg.userId).toBe('webhook');
      });
    });

    describe('verifyWebhook', () => {
      const secret = 'webhook_secret_xyz';

      it('should verify valid HMAC signature', async () => {
        const payload = { text: 'test payload', count: 5 };
        const body = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

        const result = await adapter.verifyWebhook(
          payload,
          { 'x-webhook-signature': signature },
          { secret },
        );

        expect(result).toBe(true);
      });

      it('should reject wrong HMAC signature (matching length)', async () => {
        const payload = { text: 'test' };
        const body = JSON.stringify(payload);
        const realSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
        // Corrupt the signature but keep the same length
        const badSig = realSig.slice(0, -1) + (realSig.slice(-1) === '0' ? '1' : '0');

        const result = await adapter.verifyWebhook(
          payload,
          { 'x-webhook-signature': badSig },
          { secret },
        );

        expect(result).toBe(false);
      });

      it('should throw on signature length mismatch (timingSafeEqual behavior)', async () => {
        const payload = { text: 'test' };

        let threw = false;
        try {
          await adapter.verifyWebhook(
            payload,
            { 'x-webhook-signature': 'deadbeef' },
            { secret },
          );
        } catch (err: any) {
          threw = true;
          expect(err.name).toBe('RangeError');
          expect(err.message).toContain('same byte length');
        }
        expect(threw).toBe(true);
      });

      it('should reject when signature header is missing', async () => {
        const result = await adapter.verifyWebhook(
          { text: 'test' },
          {},
          { secret },
        );

        expect(result).toBe(false);
      });

      it('should return true when no secret configured', async () => {
        const result = await adapter.verifyWebhook(
          { text: 'test' },
          {},
          {},
        );

        expect(result).toBe(true);
      });
    });

    describe('formatOutbound', () => {
      it('should include text and attachments', () => {
        const result = adapter.formatOutbound({
          text: 'Response',
          attachments: [{ url: 'http://example.com/f.pdf', type: 'pdf', name: 'file.pdf' }],
        });

        expect(result.text).toBe('Response');
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0].url).toBe('http://example.com/f.pdf');
      });
    });
  });

  describe('ChatWidgetAdapter', () => {
    let adapter: ChatWidgetAdapter;

    beforeEach(() => {
      adapter = new ChatWidgetAdapter();
    });

    it('should have type "chat_widget"', () => {
      expect(adapter.type).toBe('chat_widget');
    });

    describe('normalizeInbound', () => {
      it('should extract message field', () => {
        const msg = adapter.normalizeInbound({ message: 'User typed this', userId: 'user-123' });
        expect(msg.text).toBe('User typed this');
        expect(msg.userId).toBe('user-123');
      });

      it('should fall back to text field', () => {
        const msg = adapter.normalizeInbound({ text: 'Alt text field' });
        expect(msg.text).toBe('Alt text field');
      });

      it('should use "anonymous" as userId fallback', () => {
        const msg = adapter.normalizeInbound({ message: 'hello' });
        expect(msg.userId).toBe('anonymous');
      });

      it('should use sessionId as userId when no userId provided', () => {
        const msg = adapter.normalizeInbound({ message: 'hello', sessionId: 'sess-abc' });
        expect(msg.userId).toBe('sess-abc');
      });

      it('should use sessionId as threadId fallback', () => {
        const msg = adapter.normalizeInbound({ message: 'hello', sessionId: 'sess-xyz' });
        expect(msg.threadId).toBe('sess-xyz');
      });

      it('should set source metadata to chat_widget', () => {
        const msg = adapter.normalizeInbound({ message: 'hi' });
        expect(msg.metadata?.source).toBe('chat_widget');
      });
    });

    describe('formatOutbound', () => {
      it('should format response as message field', () => {
        const result = adapter.formatOutbound({ text: 'Bot reply' });
        expect(result.message).toBe('Bot reply');
      });
    });
  });

  describe('EmailAdapter', () => {
    let adapter: EmailAdapter;

    beforeEach(() => {
      adapter = new EmailAdapter();
    });

    it('should have type "email"', () => {
      expect(adapter.type).toBe('email');
    });

    describe('normalizeInbound', () => {
      it('should extract fields from a real email payload', () => {
        const payload = {
          from: 'user@example.com',
          to: 'agent@almyty.com',
          subject: 'Help with my order #12345',
          text: 'I need help with my recent order. Can you check the status?',
          messageId: '<abc123@mail.example.com>',
        };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.text).toBe('I need help with my recent order. Can you check the status?');
        expect(msg.userId).toBe('user@example.com');
        expect(msg.threadId).toBe('<abc123@mail.example.com>');
        expect(msg.metadata?.subject).toBe('Help with my order #12345');
        expect(msg.metadata?.from).toBe('user@example.com');
        expect(msg.metadata?.to).toBe('agent@almyty.com');
        expect(msg.metadata?.source).toBe('email');
      });

      it('should fall back to html when text is not available', () => {
        const payload = {
          from: 'sender@example.com',
          subject: 'HTML email',
          html: '<p>This is HTML content</p>',
        };

        const msg = adapter.normalizeInbound(payload);
        expect(msg.text).toBe('<p>This is HTML content</p>');
      });

      it('should fall back to body field', () => {
        const payload = {
          from: 'sender@example.com',
          body: 'Body content only',
        };

        const msg = adapter.normalizeInbound(payload);
        expect(msg.text).toBe('Body content only');
      });

      it('should use subject as threadId when messageId is missing', () => {
        const payload = {
          from: 'sender@example.com',
          subject: 'Unique Subject',
          text: 'body',
        };

        const msg = adapter.normalizeInbound(payload);
        expect(msg.threadId).toBe('Unique Subject');
      });

      it('should handle missing from field', () => {
        const payload = { text: 'no sender' };
        const msg = adapter.normalizeInbound(payload);
        expect(msg.userId).toBe('unknown');
      });

      it('should use sender field as fallback for from', () => {
        const payload = { sender: 'alt@example.com', text: 'body' };
        const msg = adapter.normalizeInbound(payload);
        expect(msg.userId).toBe('alt@example.com');
      });
    });

    describe('formatOutbound', () => {
      it('should return both html and text', () => {
        const result = adapter.formatOutbound({ text: 'Reply text' });
        expect(result.html).toBe('Reply text');
        expect(result.text).toBe('Reply text');
      });
    });
  });

  describe('TelegramAdapter', () => {
    let adapter: TelegramAdapter;

    beforeEach(() => {
      adapter = new TelegramAdapter();
    });

    it('should have type "telegram"', () => {
      expect(adapter.type).toBe('telegram');
    });

    describe('normalizeInbound', () => {
      it('should extract fields from a real Telegram update payload', () => {
        const payload = {
          message: {
            message_id: 42,
            from: { id: 987654, is_bot: false, first_name: 'John' },
            chat: { id: 123456789, type: 'private' },
            text: 'Start the agent',
            date: 1616461234,
          },
        };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.text).toBe('Start the agent');
        expect(msg.userId).toBe('987654');
        expect(msg.threadId).toBe('123456789');
        expect(msg.metadata?.chatId).toBe(123456789);
        expect(msg.metadata?.messageId).toBe(42);
        expect(msg.metadata?.source).toBe('telegram');
      });

      it('should handle payload without message wrapper', () => {
        const payload = {
          text: 'Direct text',
          from: { id: 111 },
          chat: { id: 222 },
          message_id: 10,
        };

        const msg = adapter.normalizeInbound(payload);

        expect(msg.text).toBe('Direct text');
        expect(msg.userId).toBe('111');
        expect(msg.threadId).toBe('222');
      });

      it('should handle missing from field', () => {
        const payload = {
          message: {
            text: 'no from',
            chat: { id: 555 },
            message_id: 99,
          },
        };

        const msg = adapter.normalizeInbound(payload);
        expect(msg.userId).toBe('unknown');
      });

      it('should convert chat id to string for threadId', () => {
        const payload = {
          message: {
            text: 'test',
            from: { id: 1 },
            chat: { id: -1001234567890 }, // group chat IDs are negative
            message_id: 5,
          },
        };

        const msg = adapter.normalizeInbound(payload);
        expect(msg.threadId).toBe('-1001234567890');
        expect(typeof msg.threadId).toBe('string');
      });
    });

    describe('formatOutbound', () => {
      it('should format outbound as text field', () => {
        const result = adapter.formatOutbound({ text: 'Bot response for Telegram' });
        expect(result).toEqual({ text: 'Bot response for Telegram' });
      });
    });
  });

  describe('Cross-adapter consistency', () => {
    it('all adapters should produce NormalizedMessage with required fields', () => {
      const adapters = [
        new SlackAdapter(),
        new DiscordAdapter(),
        new WebhookAdapter(),
        new ChatWidgetAdapter(),
        new EmailAdapter(),
        new TelegramAdapter(),
      ];

      for (const adapter of adapters) {
        const msg = adapter.normalizeInbound({});

        // Every adapter must always return text and userId
        expect(typeof msg.text).toBe('string');
        expect(typeof msg.userId).toBe('string');
        expect(msg.metadata).toBeDefined();
      }
    });
  });
});
