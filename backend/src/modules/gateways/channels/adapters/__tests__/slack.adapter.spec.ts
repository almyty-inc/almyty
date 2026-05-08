import * as crypto from 'crypto';
import { SlackAdapter } from '../slack.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

/**
 * Realistic Slack event-callback payload (what Slack POSTs to our
 * /webhook endpoint when a message arrives in a channel where the
 * bot is a member).
 */
const slackEventCallback = {
  token: 'verification-token',
  team_id: 'T123ABC',
  api_app_id: 'A123ABC',
  event: {
    type: 'app_mention',
    user: 'U987XYZ',
    text: '<@U_BOT> hello there',
    ts: '1700000000.000100',
    channel: 'C5555ZZ',
    thread_ts: '1700000000.000100',
  },
  type: 'event_callback',
  event_id: 'Ev123',
  event_time: 1700000000,
};

describe('SlackAdapter', () => {
  let adapter: SlackAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    adapter = new SlackAdapter();
    fetchMock = installFetchMock();
  });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts text/userId/threadId/channel from event-callback', () => {
      const result = adapter.normalizeInbound(slackEventCallback);
      expect(result.text).toBe('<@U_BOT> hello there');
      expect(result.userId).toBe('U987XYZ');
      expect(result.threadId).toBe('1700000000.000100');
      expect(result.metadata?.channel).toBe('C5555ZZ');
      expect(result.metadata?.source).toBe('slack');
    });

    it('falls back to ts when thread_ts is missing', () => {
      const noThread = {
        event: { user: 'U1', text: 'msg', ts: '999.000', channel: 'C1' },
      };
      const result = adapter.normalizeInbound(noThread);
      expect(result.threadId).toBe('999.000');
    });

    it('handles raw event payload (no event wrapper)', () => {
      const raw = { user: 'U1', text: 'hi', ts: '1.0', channel: 'C1' };
      const result = adapter.normalizeInbound(raw);
      expect(result.text).toBe('hi');
      expect(result.userId).toBe('U1');
    });

    it('defaults userId to "unknown" when missing', () => {
      const result = adapter.normalizeInbound({ event: { text: 'hi' } });
      expect(result.userId).toBe('unknown');
    });

    it('defaults text to empty string when missing', () => {
      const result = adapter.normalizeInbound({ event: { user: 'U1' } });
      expect(result.text).toBe('');
    });
  });

  describe('formatOutbound', () => {
    it('produces a Slack-compatible {text} object', () => {
      const result = adapter.formatOutbound({ text: 'hello world' });
      expect(result).toEqual({ text: 'hello world' });
    });
  });

  describe('verifyWebhook', () => {
    const signingSecret = 'super-secret-signing-key';
    const config = { signing_secret: signingSecret };

    it('returns true when there is no signing_secret configured', async () => {
      const ok = await adapter.verifyWebhook(slackEventCallback, {}, {});
      expect(ok).toBe(true);
    });

    it('accepts a correctly-signed request', async () => {
      const timestamp = '1700000000';
      const basestring = `v0:${timestamp}:${JSON.stringify(slackEventCallback)}`;
      const signature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex');
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
        config,
      );
      expect(ok).toBe(true);
    });

    it('rejects a signature with the wrong secret', async () => {
      const timestamp = '1700000000';
      const basestring = `v0:${timestamp}:${JSON.stringify(slackEventCallback)}`;
      const wrongSig = 'v0=' + crypto.createHmac('sha256', 'wrong-secret').update(basestring).digest('hex');
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': wrongSig },
        config,
      );
      expect(ok).toBe(false);
    });

    it('rejects a request without timestamp/signature headers', async () => {
      const ok = await adapter.verifyWebhook(slackEventCallback, {}, config);
      expect(ok).toBe(false);
    });
  });

  describe('sendResponse', () => {
    it('POSTs to chat.postMessage with bearer auth and threading', async () => {
      await adapter.sendResponse(
        { bot_token: 'xoxb-test-token' },
        { text: 'reply text' },
        { channel: 'C5555ZZ', threadId: '1700000000.000100' },
      );
      expect(fetchMock.calls.length).toBe(1);
      expect(fetchMock.calls[0].url).toBe('https://slack.com/api/chat.postMessage');
      expect(fetchMock.calls[0].init.method).toBe('POST');
      expect(fetchMock.calls[0].init.headers['Authorization']).toBe('Bearer xoxb-test-token');
      expect(fetchMock.calls[0].init.headers['Content-Type']).toBe('application/json');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({
        channel: 'C5555ZZ',
        text: 'reply text',
        thread_ts: '1700000000.000100',
      });
    });

    it('does not throw when fetch rejects (logs and returns)', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
      await expect(adapter.sendResponse({ bot_token: 't' }, { text: 'x' }, { channel: 'C1' })).resolves.toBeUndefined();
    });
  });
});
