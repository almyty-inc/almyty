import { IMessageLoopMessageAdapter } from '../imessage-loopmessage.adapter';
import { ChannelSendError } from '../base.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

/**
 * Recorded from LoopMessage's docs (no live account): the inbound
 * webhook, https://loopmessage.com/apidocs/conversation-api-webhooks,
 * and the send answers, https://loopmessage.com/apidocs/send-message.
 */
const inboundWebhook = {
  event: 'message_inbound',
  contact: '+13231112233',
  text: 'text',
  message_type: 'text',
  message_id: '59c55Ce8-41d6-43Cc-9116-8cfb2e696D7b',
  webhook_id: 'ab5Ae733-cCFc-4025-9987-7279b26bE71b',
  api_version: '1.0',
};

const config = { api_key: 'loop-api-key', inbound_token: 'loop-webhook-auth-0001' };

describe('IMessageLoopMessageAdapter', () => {
  let adapter: IMessageLoopMessageAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new IMessageLoopMessageAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('receive', () => {
    it('normalizes message_inbound: text, contact as user and thread', () => {
      const r = adapter.normalizeInbound(inboundWebhook);
      expect(r.text).toBe('text');
      expect(r.userId).toBe('+13231112233');
      expect(r.threadId).toBe('+13231112233');
      expect(r.metadata).toMatchObject({
        from: '+13231112233',
        messageId: '59c55Ce8-41d6-43Cc-9116-8cfb2e696D7b',
        source: 'imessage_loopmessage',
      });
    });

    it('takes an Apple ID email as the contact just the same', () => {
      expect(adapter.normalizeInbound({ ...inboundWebhook, contact: 'jo@icloud.com' }).threadId).toBe('jo@icloud.com');
    });

    it('keys the delivery on message_id, not the per-attempt webhook_id', () => {
      expect(adapter.deliveryId(inboundWebhook)).toBe('imessage_loopmessage:59c55Ce8-41d6-43Cc-9116-8cfb2e696D7b');
      expect(adapter.deliveryId({ ...inboundWebhook, webhook_id: 'another' })).toBe(adapter.deliveryId(inboundWebhook));
      expect(adapter.deliveryId({})).toBeUndefined();
    });

    it('answers only message_inbound text, one to one', () => {
      expect(adapter.carriesMessage(inboundWebhook)).toBe(true);
      for (const event of ['message_sent', 'message_delivered', 'message_failed', 'message_reaction', 'message_scheduled']) {
        expect(adapter.carriesMessage({ ...inboundWebhook, event })).toBe(false);
      }
      expect(adapter.carriesMessage({ ...inboundWebhook, group: { group_id: 'g1' } })).toBe(false);
      expect(adapter.carriesMessage({ ...inboundWebhook, text: '' })).toBe(false);
      expect(adapter.carriesMessage({ ...inboundWebhook, contact: undefined })).toBe(false);
    });
  });

  describe('verifyWebhook (configured Authorization header)', () => {
    it('accepts the configured value, bare or as a Bearer token', async () => {
      await expect(adapter.verifyWebhook(inboundWebhook, { authorization: config.inbound_token }, config)).resolves.toBe(true);
      await expect(adapter.verifyWebhook(inboundWebhook, { authorization: `Bearer ${config.inbound_token}` }, config)).resolves.toBe(true);
    });

    it('refuses a wrong value and a missing header', async () => {
      await expect(adapter.verifyWebhook(inboundWebhook, { authorization: 'loop-webhook-auth-0002' }, config)).resolves.toBe(false);
      await expect(adapter.verifyWebhook(inboundWebhook, { authorization: 'Bearer nope' }, config)).resolves.toBe(false);
      await expect(adapter.verifyWebhook(inboundWebhook, {}, config)).resolves.toBe(false);
    });

    it('fails closed when no token is configured', async () => {
      await expect(adapter.verifyWebhook(inboundWebhook, { authorization: '' }, { api_key: 'k' })).resolves.toBe(false);
      await expect(adapter.verifyWebhook(inboundWebhook, { authorization: 'Bearer ' }, { api_key: 'k', inbound_token: '' })).resolves.toBe(false);
      await expect(adapter.verifyWebhook(inboundWebhook, { authorization: 'anything' }, { api_key: 'k' })).resolves.toBe(false);
    });
  });

  describe('send', () => {
    it('POSTs message/send with the bare API key as Authorization', async () => {
      fetchMock.setNextResponse({ json: { message_id: 'OUT-1', contact: '+13231112233', text: 'Hi' } });
      await adapter.sendResponse(config, adapter.formatOutbound({ text: 'Hi' }), { from: '+13231112233' });

      const call = fetchMock.calls[0];
      expect(call.url).toBe('https://a.loopmessage.com/api/v1/message/send/');
      expect(call.init.method).toBe('POST');
      expect(call.init.headers).toMatchObject({ Authorization: 'loop-api-key', 'Content-Type': 'application/json' });
      expect(parseSentJson(call)).toEqual({ contact: '+13231112233', text: 'Hi' });
    });

    it('names the sender when one is configured', async () => {
      await adapter.sendResponse({ ...config, sender_name: 'northwind' }, { text: 'Hi' }, { threadId: '+13231112233' });
      expect(parseSentJson(fetchMock.calls[0]).sender).toBe('northwind');
    });

    it('goes through the guarded egress init', async () => {
      await adapter.sendResponse(config, { text: 'Hi' }, { from: '+1' });
      const init = fetchMock.calls[0].init;
      expect(init.redirect).toBe('error');
      expect(init.dispatcher).toBeDefined();
      expect(init.signal).toBeDefined();
    });

    it('keeps the text under LoopMessage\'s 10,000-character limit', async () => {
      await adapter.sendResponse(config, { text: 'x'.repeat(12_000) }, { from: '+1' });
      expect(parseSentJson(fetchMock.calls[0]).text).toHaveLength(9_999);
    });

    it('refuses a 400 and keeps LoopMessage\'s message and code', async () => {
      fetchMock.setNextResponse({ ok: false, status: 400, json: { success: false, code: 100, message: 'Invalid contact' } });
      const err = await adapter.sendResponse(config, { text: 'x' }, { from: '+1' }).catch((e) => e);
      expect(err).toBeInstanceOf(ChannelSendError);
      expect(err.message).toMatch(/LoopMessage refused the reply: Invalid contact \(code 100\)/);
    });

    it('refuses a 200 that says success: false', async () => {
      fetchMock.setNextResponse({ json: { success: false, message: 'Sender name is not active' } });
      await expect(adapter.sendResponse(config, { text: 'x' }, { from: '+1' })).rejects.toThrow(/Sender name is not active/);
    });

    it('refuses before calling out without an API key or a recipient', async () => {
      await expect(adapter.sendResponse({ inbound_token: 't' }, { text: 'x' }, { from: '+1' })).rejects.toThrow(/api_key/);
      await expect(adapter.sendResponse(config, { text: 'x' }, {})).rejects.toThrow(/no sender/);
      expect(fetchMock.calls).toHaveLength(0);
    });
  });
});
