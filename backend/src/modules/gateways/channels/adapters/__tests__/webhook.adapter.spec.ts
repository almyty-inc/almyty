import * as crypto from 'crypto';
import { WebhookAdapter } from '../webhook.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

describe('WebhookAdapter', () => {
  let adapter: WebhookAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new WebhookAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts text/userId/threadId from a structured payload', () => {
      const r = adapter.normalizeInbound({ text: 'hi', userId: 'u1', threadId: 't1' });
      expect(r.text).toBe('hi');
      expect(r.userId).toBe('u1');
      expect(r.threadId).toBe('t1');
      expect(r.metadata?.source).toBe('webhook');
    });
    it('falls back to message/input keys, then JSON-stringifies', () => {
      const r = adapter.normalizeInbound({ arbitrary: 'data', count: 3 });
      expect(r.text).toContain('arbitrary');
      expect(r.userId).toBe('webhook');
    });
  });

  describe('verifyWebhook', () => {
    const secret = 'shared-secret';
    const payload = { hello: 'world' };
    function sign(body: any) {
      return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
    }

    it('refuses inbound when no secret is configured', async () => {
      expect(await adapter.verifyWebhook(payload, {}, {})).toBe(false);
    });

    it('rejects rather than throwing when the signature length differs', async () => {
      expect(
        await adapter.verifyWebhook(payload, { 'x-webhook-signature': 'deadbeef' }, { secret }),
      ).toBe(false);
    });
    it('accepts a correctly-signed payload', async () => {
      const ok = await adapter.verifyWebhook(payload, { 'x-webhook-signature': sign(payload) }, { secret });
      expect(ok).toBe(true);
    });
    it('rejects without signature header', async () => {
      expect(await adapter.verifyWebhook(payload, {}, { secret })).toBe(false);
    });
    it('rejects wrong signature', async () => {
      const ok = await adapter.verifyWebhook(payload, { 'x-webhook-signature': 'a'.repeat(64) }, { secret });
      expect(ok).toBe(false);
    });
  });

  describe('sendResponse', () => {
    it('POSTs to callback_url with HMAC signature', async () => {
      await adapter.sendResponse(
        { callback_url: 'https://callback.example/hook', secret: 'sek' },
        { text: 'reply', attachments: [] },
        {},
      );
      expect(fetchMock.calls[0].url).toBe('https://callback.example/hook');
      const sig = fetchMock.calls[0].init.headers['X-Webhook-Signature'];
      expect(sig).toBeDefined();
      const expected = crypto.createHmac('sha256', 'sek')
        .update(JSON.stringify({ text: 'reply', attachments: [] }))
        .digest('hex');
      expect(sig).toBe(expected);
    });
    /**
     * Nothing here but HTTP, so a non-2xx is the whole verdict — and an
     * unconfigured callback_url means the reply had nowhere to go at
     * all. Both used to be silent.
     */
    it('refuses rather than skipping when no callback URL is configured', async () => {
      await expect(adapter.sendResponse({}, { text: 'x' }, {})).rejects.toThrow(
        /no callback_url or webhook_url is configured/,
      );
      expect(fetchMock.calls.length).toBe(0);
    });

    it('accepts webhook_url too, because testConnection does', async () => {
      // `testConnection` for this gateway type passes on either key. When
      // the adapter read only `callback_url`, a gateway configured with
      // `webhook_url` passed its connection test and then refused every
      // send — two paths disagreeing about one config key, which is the
      // shape that made a dropped reply look delivered.
      fetchMock.setNextResponse({ ok: true, status: 200, text: '' });
      await adapter.sendResponse({ webhook_url: 'https://callback.example/hook' }, { text: 'x' }, {});
      expect(fetchMock.calls[0].url).toBe('https://callback.example/hook');
    });

    it('refuses a non-2xx and keeps the callback\'s status and body', async () => {
      fetchMock.setNextResponse({ ok: false, status: 502, text: 'upstream connect error' });
      await expect(
        adapter.sendResponse({ callback_url: 'https://callback.example/hook' }, { text: 'x' }, {}),
      ).rejects.toThrow(/502.*upstream connect error/);
    });

    it('does not swallow a network failure', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('dns'));
      await expect(
        adapter.sendResponse({ callback_url: 'https://callback.example/hook' }, { text: 'x' }, {}),
      ).rejects.toThrow('dns');
    });
  });
});
