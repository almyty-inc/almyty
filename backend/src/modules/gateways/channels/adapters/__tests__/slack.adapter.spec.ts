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

    /** Sign a payload exactly the way Slack does, at a chosen clock. */
    const sign = (payload: any, timestamp: string) => {
      const basestring = `v0:${timestamp}:${JSON.stringify(payload)}`;
      return 'v0=' + crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex');
    };
    const nowSeconds = () => Math.floor(Date.now() / 1000);

    it('refuses inbound when there is no signing_secret configured', async () => {
      // Fail closed: with no secret we cannot tell Slack from a forger.
      const ok = await adapter.verifyWebhook(slackEventCallback, {}, {});
      expect(ok).toBe(false);
    });

    it('rejects rather than throwing when the signature length differs', async () => {
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': String(nowSeconds()), 'x-slack-signature': 'v0=short' },
        config,
      );
      expect(ok).toBe(false);
    });

    it('accepts a correctly-signed request', async () => {
      const timestamp = String(nowSeconds());
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': sign(slackEventCallback, timestamp) },
        config,
      );
      expect(ok).toBe(true);
    });

    it('rejects a signature with the wrong secret', async () => {
      const timestamp = String(nowSeconds());
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

    // ── Replay window ────────────────────────────────────────────────
    //
    // A signature authenticates a request, it does not date it. Without
    // the window, a captured Slack POST stayed valid until the signing
    // secret was rotated — and for slash commands and interactive
    // payloads (no event_id, no event.ts) `deliveryId` is undefined, so
    // the dedupe claim never sees the replay either. Each replay was a
    // fresh agent run on the tenant's model keys.

    it('refuses a correctly-signed delivery whose timestamp is stale', async () => {
      const stale = String(nowSeconds() - SlackAdapter.TIMESTAMP_TOLERANCE_SECONDS - 1);
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': stale, 'x-slack-signature': sign(slackEventCallback, stale) },
        config,
      );
      expect(ok).toBe(false);
    });

    it('refuses a correctly-signed delivery timestamped in the future', async () => {
      // Symmetric: a clock far ahead is as good as a captured one for
      // extending a signature's life.
      const ahead = String(nowSeconds() + SlackAdapter.TIMESTAMP_TOLERANCE_SECONDS + 1);
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': ahead, 'x-slack-signature': sign(slackEventCallback, ahead) },
        config,
      );
      expect(ok).toBe(false);
    });

    it('still accepts a delivery at the edge of the window', async () => {
      // One second inside, so the window is a window and not a
      // stricter-than-Slack rejection of ordinary delivery latency.
      const edge = String(nowSeconds() - SlackAdapter.TIMESTAMP_TOLERANCE_SECONDS + 1);
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': edge, 'x-slack-signature': sign(slackEventCallback, edge) },
        config,
      );
      expect(ok).toBe(true);
    });

    it('refuses a non-numeric timestamp instead of treating it as epoch 0', async () => {
      const bogus = 'not-a-number';
      const ok = await adapter.verifyWebhook(
        slackEventCallback,
        { 'x-slack-request-timestamp': bogus, 'x-slack-signature': sign(slackEventCallback, bogus) },
        config,
      );
      expect(ok).toBe(false);
    });
  });

  describe('sendResponse', () => {
    it('POSTs to chat.postMessage with bearer auth and threading', async () => {
      fetchMock.setNextResponse({ json: { ok: true, channel: 'C5555ZZ', ts: '1700000000.000200' } });
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

    /**
     * The one that made a dropped reply look delivered.
     *
     * Slack does not use the HTTP status to refuse a post: removing the
     * bot from the channel, deleting the channel or revoking the token
     * all come back as HTTP 200 with `ok: false`. An adapter that
     * checked only the transport — or, as this one did, checked nothing
     * at all — reported every one of those as sent, and the outbound
     * event row said `processed` with no error while the customer sat
     * there unanswered.
     */
    it('refuses an HTTP 200 that carries ok:false, with Slack\'s own error', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: { ok: false, error: 'not_in_channel' } });
      await expect(
        adapter.sendResponse({ bot_token: 'xoxb' }, { text: 'x' }, { channel: 'C1' }),
      ).rejects.toThrow(/not_in_channel/);
    });

    it('refuses an HTTP 200 that confirms nothing', async () => {
      // No `ok` at all is not a confirmation either.
      fetchMock.setNextResponse({ ok: true, status: 200, json: {} });
      await expect(
        adapter.sendResponse({ bot_token: 'xoxb' }, { text: 'x' }, { channel: 'C1' }),
      ).rejects.toThrow(/did not confirm/);
    });

    it('refuses a transport-level rejection and names the status', async () => {
      fetchMock.setNextResponse({ ok: false, status: 429, json: { ok: false, error: 'ratelimited' } });
      await expect(
        adapter.sendResponse({ bot_token: 'xoxb' }, { text: 'x' }, { channel: 'C1' }),
      ).rejects.toThrow(/429.*ratelimited/);
    });

    it('does not swallow a network failure', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
      await expect(
        adapter.sendResponse({ bot_token: 't' }, { text: 'x' }, { channel: 'C1' }),
      ).rejects.toThrow('network down');
    });

    it('never puts the bot token in the failure it reports', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: { ok: false, error: 'invalid_auth' } });
      const error = await adapter
        .sendResponse({ bot_token: 'xoxb-super-secret' }, { text: 'x' }, { channel: 'C1' })
        .then(() => null, (e) => e);
      expect(error).toBeTruthy();
      expect(error.message).toContain('invalid_auth');
      expect(error.message).not.toContain('xoxb-super-secret');
    });
  });
});
