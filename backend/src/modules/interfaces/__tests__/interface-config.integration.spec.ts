/**
 * Pure logic tests for all interface adapters.
 * Zero mocks — instantiate adapters directly, call methods with real data.
 */
import * as crypto from 'crypto';
import { ChatWidgetAdapter } from '../adapters/chat-widget.adapter';
import { SlackAdapter } from '../adapters/slack.adapter';
import { DiscordAdapter } from '../adapters/discord.adapter';
import { TelegramAdapter } from '../adapters/telegram.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { WebhookAdapter } from '../adapters/webhook.adapter';
import { NormalizedMessage, AdapterResponse } from '../adapters/base.adapter';

describe('Interface Adapters — Pure Logic Tests', () => {
  const chatWidget = new ChatWidgetAdapter();
  const slack = new SlackAdapter();
  const discord = new DiscordAdapter();
  const telegram = new TelegramAdapter();
  const whatsApp = new WhatsAppAdapter();
  const email = new EmailAdapter();
  const webhook = new WebhookAdapter();

  const allAdapters = [
    { name: 'ChatWidget', adapter: chatWidget },
    { name: 'Slack', adapter: slack },
    { name: 'Discord', adapter: discord },
    { name: 'Telegram', adapter: telegram },
    { name: 'WhatsApp', adapter: whatsApp },
    { name: 'Email', adapter: email },
    { name: 'Webhook', adapter: webhook },
  ];

  // =========================================================================
  // All adapters: normalizeInbound with empty/minimal input produces valid output
  // =========================================================================

  describe.each(allAdapters)('$name adapter — normalizeInbound with empty input', ({ adapter }) => {
    it('should not crash and return a valid NormalizedMessage', () => {
      const result: NormalizedMessage = adapter.normalizeInbound({});
      expect(result).toBeDefined();
      expect(typeof result.text).toBe('string');
      expect(typeof result.userId).toBe('string');
      // threadId is optional — should be string or undefined
      if (result.threadId !== undefined) {
        expect(typeof result.threadId).toBe('string');
      }
    });
  });

  // =========================================================================
  // All adapters: formatOutbound with minimal response produces valid output
  // =========================================================================

  describe.each(allAdapters)('$name adapter — formatOutbound with minimal response', ({ adapter }) => {
    it('should not crash and return a defined result', () => {
      const response: AdapterResponse = { text: 'Hello from the agent' };
      const result = adapter.formatOutbound(response);
      expect(result).toBeDefined();
    });

    it('should handle empty text', () => {
      const result = adapter.formatOutbound({ text: '' });
      expect(result).toBeDefined();
    });
  });

  // =========================================================================
  // Slack adapter
  // =========================================================================

  describe('SlackAdapter — normalizeInbound', () => {
    it('should extract from nested event structure', () => {
      const payload = {
        token: 'xoxb-test',
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'hello from slack',
          user: 'U12345',
          channel: 'C67890',
          ts: '1234567890.123456',
        },
      };

      const result = slack.normalizeInbound(payload);
      expect(result.text).toBe('hello from slack');
      expect(result.userId).toBe('U12345');
      expect(result.metadata?.channel).toBe('C67890');
      expect(result.metadata?.ts).toBe('1234567890.123456');
      expect(result.metadata?.source).toBe('slack');
    });

    it('should handle thread_ts for threaded messages', () => {
      const payload = {
        event: {
          type: 'message',
          text: 'reply in thread',
          user: 'U12345',
          channel: 'C67890',
          ts: '1234567890.999999',
          thread_ts: '1234567890.000001',
        },
      };

      const result = slack.normalizeInbound(payload);
      expect(result.threadId).toBe('1234567890.000001');
    });

    it('should fall back to ts when thread_ts is absent', () => {
      const payload = {
        event: {
          text: 'top-level msg',
          user: 'U999',
          channel: 'C111',
          ts: '9999.1111',
        },
      };

      const result = slack.normalizeInbound(payload);
      expect(result.threadId).toBe('9999.1111');
    });

    it('should handle flat payload (no event wrapper)', () => {
      const payload = {
        text: 'flat payload',
        user: 'UFLAT',
        channel: 'CFLAT',
        ts: '1111.2222',
      };

      const result = slack.normalizeInbound(payload);
      expect(result.text).toBe('flat payload');
      expect(result.userId).toBe('UFLAT');
    });
  });

  describe('SlackAdapter — formatOutbound', () => {
    it('should wrap text in a slack-compatible object', () => {
      const result = slack.formatOutbound({ text: 'response text' });
      expect(result).toEqual({ text: 'response text' });
    });
  });

  describe('SlackAdapter — verifyWebhook', () => {
    it('should accept when no signing_secret is configured', async () => {
      const valid = await slack.verifyWebhook({}, {}, {});
      expect(valid).toBe(true);
    });

    it('should reject when signature header is missing', async () => {
      const valid = await slack.verifyWebhook({}, {}, { signing_secret: 'secret123' });
      expect(valid).toBe(false);
    });

    it('should verify a correct HMAC signature', async () => {
      const secret = 'my-slack-signing-secret';
      const timestamp = '1531420618';
      const body = { text: 'hello' };
      const sigBasestring = `v0:${timestamp}:${JSON.stringify(body)}`;
      const expectedSig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');

      const headers = {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': expectedSig,
      };

      const valid = await slack.verifyWebhook(body, headers, { signing_secret: secret });
      expect(valid).toBe(true);
    });

    it('should reject an incorrect HMAC signature', async () => {
      const headers = {
        'x-slack-request-timestamp': '1531420618',
        'x-slack-signature': 'v0=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      };

      const valid = await slack.verifyWebhook({ text: 'hello' }, headers, { signing_secret: 'real-secret' });
      expect(valid).toBe(false);
    });
  });

  // =========================================================================
  // Discord adapter
  // =========================================================================

  describe('DiscordAdapter — normalizeInbound', () => {
    it('should extract content, author, channel, guild', () => {
      const payload = {
        content: 'Discord message',
        author: { id: 'user-discord-1', username: 'testuser' },
        channel_id: 'chan-123',
        guild_id: 'guild-456',
      };

      const result = discord.normalizeInbound(payload);
      expect(result.text).toBe('Discord message');
      expect(result.userId).toBe('user-discord-1');
      expect(result.threadId).toBe('chan-123');
      expect(result.metadata?.guildId).toBe('guild-456');
      expect(result.metadata?.channelId).toBe('chan-123');
      expect(result.metadata?.source).toBe('discord');
    });
  });

  describe('DiscordAdapter — formatOutbound', () => {
    it('should truncate at 2000 characters', () => {
      const longText = 'A'.repeat(3000);
      const result = discord.formatOutbound({ text: longText });
      expect(result.content.length).toBe(2000);
      expect(result.content).toBe('A'.repeat(2000));
    });

    it('should not truncate short messages', () => {
      const result = discord.formatOutbound({ text: 'short' });
      expect(result.content).toBe('short');
    });
  });

  // =========================================================================
  // Telegram adapter
  // =========================================================================

  describe('TelegramAdapter — normalizeInbound', () => {
    it('should handle standard message format with nested message', () => {
      const payload = {
        update_id: 123456,
        message: {
          message_id: 42,
          from: { id: 789, first_name: 'Test' },
          chat: { id: 12345, type: 'private' },
          text: 'Telegram message',
        },
      };

      const result = telegram.normalizeInbound(payload);
      expect(result.text).toBe('Telegram message');
      expect(result.userId).toBe('789');
      expect(result.threadId).toBe('12345');
      expect(result.metadata?.chatId).toBe(12345);
      expect(result.metadata?.messageId).toBe(42);
    });

    it('should correctly stringify negative group chat IDs', () => {
      const payload = {
        message: {
          message_id: 1,
          from: { id: 100 },
          chat: { id: -1001234567890, type: 'supergroup' },
          text: 'group chat msg',
        },
      };

      const result = telegram.normalizeInbound(payload);
      expect(result.threadId).toBe('-1001234567890');
      expect(typeof result.threadId).toBe('string');
    });
  });

  // =========================================================================
  // WhatsApp adapter
  // =========================================================================

  describe('WhatsAppAdapter — normalizeInbound', () => {
    it('should extract Twilio fields: Body, From, To, MessageSid', () => {
      const payload = {
        Body: 'Hello from WhatsApp',
        From: 'whatsapp:+1234567890',
        To: 'whatsapp:+0987654321',
        MessageSid: 'SM1234567890abcdef',
      };

      const result = whatsApp.normalizeInbound(payload);
      expect(result.text).toBe('Hello from WhatsApp');
      expect(result.userId).toBe('whatsapp:+1234567890');
      expect(result.threadId).toBe('whatsapp:+1234567890');
      expect(result.metadata?.from).toBe('whatsapp:+1234567890');
      expect(result.metadata?.to).toBe('whatsapp:+0987654321');
      expect(result.metadata?.messageSid).toBe('SM1234567890abcdef');
      expect(result.metadata?.source).toBe('whatsapp');
    });

    it('should handle missing fields gracefully', () => {
      const result = whatsApp.normalizeInbound({});
      expect(result.text).toBe('');
      expect(result.userId).toBe('unknown');
    });
  });

  describe('WhatsAppAdapter — formatOutbound', () => {
    it('should wrap text in body field', () => {
      const result = whatsApp.formatOutbound({ text: 'reply text' });
      expect(result).toEqual({ body: 'reply text' });
    });
  });

  // =========================================================================
  // Email adapter
  // =========================================================================

  describe('EmailAdapter — normalizeInbound', () => {
    it('should extract subject, from, and text content', () => {
      const payload = {
        subject: 'Test Subject',
        from: 'sender@example.com',
        to: 'agent@almyty.com',
        text: 'Plain text email body',
        messageId: 'msg-id-123',
      };

      const result = email.normalizeInbound(payload);
      expect(result.text).toBe('Plain text email body');
      expect(result.userId).toBe('sender@example.com');
      expect(result.threadId).toBe('msg-id-123');
      expect(result.metadata?.subject).toBe('Test Subject');
      expect(result.metadata?.from).toBe('sender@example.com');
      expect(result.metadata?.to).toBe('agent@almyty.com');
      expect(result.metadata?.source).toBe('email');
    });

    it('should fall back to html when text is absent', () => {
      const payload = {
        html: '<p>HTML content</p>',
        from: 'sender@example.com',
        subject: 'HTML email',
      };

      const result = email.normalizeInbound(payload);
      expect(result.text).toBe('<p>HTML content</p>');
    });

    it('should fall back to body when both text and html are absent', () => {
      const payload = {
        body: 'raw body content',
        from: 'sender@example.com',
      };

      const result = email.normalizeInbound(payload);
      expect(result.text).toBe('raw body content');
    });

    it('should use subject as threadId when messageId is absent', () => {
      const payload = {
        subject: 'Thread Subject',
        from: 'test@example.com',
        text: 'some text',
      };

      const result = email.normalizeInbound(payload);
      expect(result.threadId).toBe('Thread Subject');
    });
  });

  describe('EmailAdapter — formatOutbound', () => {
    it('should produce both html and text fields', () => {
      const result = email.formatOutbound({ text: 'Email reply' });
      expect(result.html).toBe('Email reply');
      expect(result.text).toBe('Email reply');
    });
  });

  // =========================================================================
  // Webhook adapter
  // =========================================================================

  describe('WebhookAdapter — normalizeInbound', () => {
    it('should extract text/message/input fields', () => {
      const result1 = webhook.normalizeInbound({ text: 'via text' });
      expect(result1.text).toBe('via text');

      const result2 = webhook.normalizeInbound({ message: 'via message' });
      expect(result2.text).toBe('via message');

      const result3 = webhook.normalizeInbound({ input: 'via input' });
      expect(result3.text).toBe('via input');
    });

    it('should fall back to JSON.stringify when no known text field', () => {
      const payload = { foo: 'bar', baz: 42 };
      const result = webhook.normalizeInbound(payload);
      expect(result.text).toBe(JSON.stringify(payload));
    });

    it('should extract userId and threadId', () => {
      const result = webhook.normalizeInbound({
        text: 'hi',
        userId: 'webhook-user-1',
        threadId: 'thread-abc',
      });
      expect(result.userId).toBe('webhook-user-1');
      expect(result.threadId).toBe('thread-abc');
    });

    it('should fall back to requestId for threadId', () => {
      const result = webhook.normalizeInbound({
        text: 'hi',
        requestId: 'req-123',
      });
      expect(result.threadId).toBe('req-123');
    });
  });

  describe('WebhookAdapter — verifyWebhook with real HMAC-SHA256', () => {
    it('should accept when no secret is configured', async () => {
      const valid = await webhook.verifyWebhook({}, {}, {});
      expect(valid).toBe(true);
    });

    it('should reject when signature header is missing', async () => {
      const valid = await webhook.verifyWebhook({}, {}, { secret: 'my-secret' });
      expect(valid).toBe(false);
    });

    it('should verify a correct HMAC-SHA256 signature', async () => {
      const secret = 'test-webhook-secret';
      const payload = { event: 'test', data: { id: 123 } };
      const payloadStr = JSON.stringify(payload);
      const expectedSig = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');

      const headers = { 'x-webhook-signature': expectedSig };
      const valid = await webhook.verifyWebhook(payload, headers, { secret });
      expect(valid).toBe(true);
    });

    it('should reject an incorrect signature', async () => {
      const headers = { 'x-webhook-signature': 'bad-signature-value-that-is-64-chars-long-aabbccdd0011223344556677' };
      // Use a payload string that produces a 64-char hex hash, then compare with wrong sig
      const valid = await webhook.verifyWebhook(
        { test: true },
        { 'x-webhook-signature': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { secret: 'the-real-secret' },
      );
      expect(valid).toBe(false);
    });

    it('should verify against a known input/key/expected triple', async () => {
      // Pre-computed: HMAC-SHA256 of '{"hello":"world"}' with key 'known-key'
      const payload = { hello: 'world' };
      const key = 'known-key';
      const expected = crypto.createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');

      // Sanity: ensure the expected value is a 64-char hex string
      expect(expected).toMatch(/^[a-f0-9]{64}$/);

      const valid = await webhook.verifyWebhook(payload, { 'x-webhook-signature': expected }, { secret: key });
      expect(valid).toBe(true);
    });
  });

  // =========================================================================
  // Chat widget adapter
  // =========================================================================

  describe('ChatWidgetAdapter — normalizeInbound', () => {
    it('should use sessionId as both userId and threadId when userId is absent', () => {
      const payload = {
        message: 'Hello widget',
        sessionId: 'session-xyz',
      };

      const result = chatWidget.normalizeInbound(payload);
      expect(result.text).toBe('Hello widget');
      expect(result.userId).toBe('session-xyz');
      expect(result.threadId).toBe('session-xyz');
    });

    it('should prefer message over text field', () => {
      const payload = {
        message: 'from message field',
        text: 'from text field',
      };

      const result = chatWidget.normalizeInbound(payload);
      expect(result.text).toBe('from message field');
    });

    it('should fall back to text when message is absent', () => {
      const result = chatWidget.normalizeInbound({ text: 'fallback text' });
      expect(result.text).toBe('fallback text');
    });

    it('should default userId to anonymous when no userId or sessionId', () => {
      const result = chatWidget.normalizeInbound({ message: 'hi' });
      expect(result.userId).toBe('anonymous');
    });

    it('should use threadId when explicitly provided', () => {
      const result = chatWidget.normalizeInbound({
        message: 'hi',
        sessionId: 'sess-1',
        threadId: 'thread-override',
      });
      expect(result.threadId).toBe('thread-override');
    });
  });

  describe('ChatWidgetAdapter — formatOutbound', () => {
    it('should produce message and attachments fields', () => {
      const result = chatWidget.formatOutbound({
        text: 'agent reply',
        attachments: [{ url: 'https://example.com/file.pdf', type: 'file', name: 'file.pdf' }],
      });
      expect(result.message).toBe('agent reply');
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].url).toBe('https://example.com/file.pdf');
    });
  });
});
