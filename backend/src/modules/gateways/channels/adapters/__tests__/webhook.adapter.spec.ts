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

    it('returns true when no secret configured', async () => {
      expect(await adapter.verifyWebhook(payload, {}, {})).toBe(true);
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
    it('skips when callback_url missing', async () => {
      await adapter.sendResponse({}, { text: 'x' }, {});
      expect(fetchMock.calls.length).toBe(0);
    });
  });
});
