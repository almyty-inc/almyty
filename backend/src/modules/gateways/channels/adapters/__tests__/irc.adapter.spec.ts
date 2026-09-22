import { IrcAdapter } from '../irc.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

describe('IrcAdapter', () => {
  let adapter: IrcAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new IrcAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts text/nick/channel from a webhook bridge payload', () => {
      const r = adapter.normalizeInbound({
        text: 'hello',
        nick: 'alice',
        channel: '#general',
        server: 'irc.example.com',
      });
      expect(r.text).toBe('hello');
      expect(r.userId).toBe('alice');
      expect(r.threadId).toBe('#general');
      expect(r.metadata?.server).toBe('irc.example.com');
      expect(r.metadata?.source).toBe('irc');
    });
    it('falls back to message/from/username keys', () => {
      const r = adapter.normalizeInbound({ message: 'hi', username: 'bob' });
      expect(r.text).toBe('hi');
      expect(r.userId).toBe('bob');
    });
  });

  describe('formatOutbound', () => {
    it('produces {text}', () => {
      expect(adapter.formatOutbound({ text: 'r' })).toEqual({ text: 'r' });
    });
  });

  describe('sendResponse', () => {
    it('POSTs to the configured webhook bridge URL', async () => {
      await adapter.sendResponse(
        { webhook_url: 'https://bridge.example/webhook', nick: 'almytybot' },
        { text: 'reply' },
        { threadId: '#dev' },
      );
      expect(fetchMock.calls[0].url).toBe('https://bridge.example/webhook');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({
        text: 'reply',
        channel: '#dev',
        username: 'almytybot',
      });
    });
    it('falls back to config.channel when threadId missing', async () => {
      await adapter.sendResponse(
        { webhook_url: 'https://bridge.example/webhook', channel: '#fallback' },
        { text: 'r' },
        {},
      );
      expect(parseSentJson(fetchMock.calls[0]).channel).toBe('#fallback');
    });
    it('refuses rather than skipping when webhook_url is missing', async () => {
      await expect(adapter.sendResponse({}, { text: 'r' }, { threadId: '#x' })).rejects.toThrow(
        /webhook_url is not configured/,
      );
      expect(fetchMock.calls.length).toBe(0);
    });
  });

  describe('bridge authentication', () => {
    it('sends Authorization: Bearer when bridge_token is configured', async () => {
      await adapter.sendResponse(
        { webhook_url: 'https://bridge.example/webhook', bridge_token: 'brt-1' },
        { text: 'r' },
        { threadId: '#dev' },
      );
      expect(fetchMock.calls[0].init.headers['Authorization']).toBe('Bearer brt-1');
    });
    it('sends no Authorization header without bridge_token', async () => {
      await adapter.sendResponse(
        { webhook_url: 'https://bridge.example/webhook' },
        { text: 'r' },
        { threadId: '#dev' },
      );
      expect(fetchMock.calls[0].init.headers['Authorization']).toBeUndefined();
    });

    /**
     * This one already noticed the bridge's refusal — and logged it,
     * which the dispatch path cannot see, so the outbound row still
     * said `processed`.
     */
    it('refuses when the bridge rejects, with its status and body', async () => {
      fetchMock.setNextResponse({ ok: false, status: 502, text: 'bad gateway' });
      await expect(
        adapter.sendResponse({ webhook_url: 'https://bridge.example/webhook' }, { text: 'r' }, {}),
      ).rejects.toThrow(/502.*bad gateway/);
    });

    it('never puts the bridge token in the failure it reports', async () => {
      fetchMock.setNextResponse({ ok: false, status: 401, text: 'unauthorized' });
      const error = await adapter
        .sendResponse(
          { webhook_url: 'https://bridge.example/webhook', bridge_token: 'brt-super-secret' },
          { text: 'r' },
          {},
        )
        .then(() => null, (e) => e);
      expect(error).toBeTruthy();
      expect(error.message).not.toContain('brt-super-secret');
    });
  });

  describe('verifyWebhook (inbound_token)', () => {
    const config = { inbound_token: 'sekrit' };

    it('accepts a matching Bearer token', async () => {
      expect(await adapter.verifyWebhook({}, { authorization: 'Bearer sekrit' }, config)).toBe(true);
    });
    it('accepts a matching X-Bridge-Token header', async () => {
      expect(await adapter.verifyWebhook({}, { 'x-bridge-token': 'sekrit' }, config)).toBe(true);
    });
    it('rejects a wrong or missing token', async () => {
      expect(await adapter.verifyWebhook({}, { authorization: 'Bearer wrong' }, config)).toBe(false);
      expect(await adapter.verifyWebhook({}, {}, config)).toBe(false);
    });
    it('refuses inbound when inbound_token is not configured', async () => {
      expect(await adapter.verifyWebhook({}, {}, {})).toBe(false);
    });
  });
});
