import { IMessageSendblueAdapter } from '../imessage-sendblue.adapter';
import { ChannelSendError } from '../base.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

/**
 * Recorded from Sendblue's docs (no live account): the receive webhook
 * body, https://docs.sendblue.com/getting-started/webhooks/, and the
 * send-message answer, https://docs.sendblue.com/api/resources/messages/methods/send/.
 */
const receiveWebhook = {
  accountEmail: 'ops@northwind.example',
  content: 'Hello!',
  is_outbound: false,
  status: 'RECEIVED',
  message_handle: '99DCC379-DD76-4712-BA65-11EFB33B8CD6',
  date_sent: '2025-12-12T15:41:20.932Z',
  from_number: '+19998887777',
  to_number: '+15122164639',
  service: 'iMessage',
};

const config = {
  api_key_id: 'sb-key-id',
  api_secret_key: 'sb-secret-key',
  phone_number: '+15122164639',
  signing_secret: 'sb-webhook-secret-0001',
};

describe('IMessageSendblueAdapter', () => {
  let adapter: IMessageSendblueAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new IMessageSendblueAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('receive', () => {
    it('normalizes the receive webhook: content, sender as user and thread', () => {
      const r = adapter.normalizeInbound(receiveWebhook);
      expect(r.text).toBe('Hello!');
      expect(r.userId).toBe('+19998887777');
      expect(r.threadId).toBe('+19998887777');
      expect(r.metadata).toMatchObject({
        from: '+19998887777',
        to: '+15122164639',
        messageHandle: '99DCC379-DD76-4712-BA65-11EFB33B8CD6',
        service: 'iMessage',
        source: 'imessage_sendblue',
      });
    });

    it('survives an empty body', () => {
      const r = adapter.normalizeInbound({});
      expect(r.text).toBe('');
      expect(r.userId).toBe('unknown');
    });

    it('keys the delivery on message_handle', () => {
      expect(adapter.deliveryId(receiveWebhook)).toBe('imessage_sendblue:99DCC379-DD76-4712-BA65-11EFB33B8CD6');
      expect(adapter.deliveryId({})).toBeUndefined();
    });

    it('answers only inbound 1:1 text', () => {
      expect(adapter.carriesMessage(receiveWebhook)).toBe(true);
      expect(adapter.carriesMessage({ ...receiveWebhook, is_outbound: true })).toBe(false);
      expect(adapter.carriesMessage({ ...receiveWebhook, group_id: 'grp-1' })).toBe(false);
      expect(adapter.carriesMessage({ ...receiveWebhook, content: '   ' })).toBe(false);
      expect(adapter.carriesMessage({ ...receiveWebhook, from_number: undefined })).toBe(false);
      expect(adapter.carriesMessage(null)).toBe(false);
    });
  });

  describe('verifyWebhook (sb-signing-secret)', () => {
    it('accepts the configured secret', async () => {
      await expect(adapter.verifyWebhook(receiveWebhook, { 'sb-signing-secret': config.signing_secret }, config)).resolves.toBe(true);
    });

    it('refuses a wrong secret, a missing header, and a secret of another length', async () => {
      await expect(adapter.verifyWebhook(receiveWebhook, { 'sb-signing-secret': 'sb-webhook-secret-0002' }, config)).resolves.toBe(false);
      await expect(adapter.verifyWebhook(receiveWebhook, {}, config)).resolves.toBe(false);
      await expect(adapter.verifyWebhook(receiveWebhook, { 'sb-signing-secret': 'short' }, config)).resolves.toBe(false);
    });

    it('fails closed when no secret is configured, whatever is presented', async () => {
      const { signing_secret: _unset, ...unconfigured } = config;
      await expect(adapter.verifyWebhook(receiveWebhook, { 'sb-signing-secret': '' }, unconfigured)).resolves.toBe(false);
      await expect(adapter.verifyWebhook(receiveWebhook, { 'sb-signing-secret': 'anything' }, unconfigured)).resolves.toBe(false);
      await expect(adapter.verifyWebhook(receiveWebhook, { 'sb-signing-secret': '' }, { ...config, signing_secret: '' })).resolves.toBe(false);
    });
  });

  describe('send', () => {
    it('POSTs send-message with both key headers, from the line to the sender', async () => {
      fetchMock.setNextResponse({ json: { status: 'QUEUED', message_handle: 'OUT-1', error_code: null, error_message: null } });
      await adapter.sendResponse(config, adapter.formatOutbound({ text: 'Shipped yesterday.' }), { from: '+19998887777' });

      expect(fetchMock.calls).toHaveLength(1);
      const call = fetchMock.calls[0];
      expect(call.url).toBe('https://api.sendblue.co/api/send-message');
      expect(call.init.method).toBe('POST');
      expect(call.init.headers).toMatchObject({
        'sb-api-key-id': 'sb-key-id',
        'sb-api-secret-key': 'sb-secret-key',
        'Content-Type': 'application/json',
      });
      expect(parseSentJson(call)).toEqual({ number: '+19998887777', from_number: '+15122164639', content: 'Shipped yesterday.' });
    });

    it('goes through the guarded egress init: no redirects, the pinned dispatcher, a deadline', async () => {
      await adapter.sendResponse(config, { content: 'x' }, { threadId: '+19998887777' });
      const init = fetchMock.calls[0].init;
      expect(init.redirect).toBe('error');
      expect(init.dispatcher).toBeDefined();
      expect(init.signal).toBeDefined();
    });

    it('truncates past Sendblue\'s 18,996-character limit', async () => {
      await adapter.sendResponse(config, { content: 'x'.repeat(20_000) }, { from: '+1' });
      expect(parseSentJson(fetchMock.calls[0]).content).toHaveLength(IMessageSendblueAdapter.MAX_CONTENT_CHARS);
    });

    it('refuses a 2xx whose message came back ERROR, keeping Sendblue\'s wording', async () => {
      fetchMock.setNextResponse({ json: { status: 'ERROR', error_key: 'PRE_REPLY_LIMIT_REACHED', error_message: 'Pre-reply limit reached' } });
      await expect(adapter.sendResponse(config, { content: 'x' }, { from: '+1' })).rejects.toThrow(
        /Sendblue refused the reply: Pre-reply limit reached \(PRE_REPLY_LIMIT_REACHED\)/,
      );
    });

    it('refuses a non-2xx', async () => {
      fetchMock.setNextResponse({ ok: false, status: 401, json: { message: 'Unauthorized' } });
      const err = await adapter.sendResponse(config, { content: 'x' }, { from: '+1' }).catch((e) => e);
      expect(err).toBeInstanceOf(ChannelSendError);
      expect(err.message).toMatch(/Unauthorized/);
    });

    it('refuses before calling out when keys or the line are missing', async () => {
      await expect(adapter.sendResponse({ ...config, api_secret_key: '' }, { content: 'x' }, { from: '+1' })).rejects.toThrow(/api_secret_key/);
      await expect(adapter.sendResponse({ ...config, phone_number: '' }, { content: 'x' }, { from: '+1' })).rejects.toThrow(/phone_number/);
      await expect(adapter.sendResponse(config, { content: 'x' }, {})).rejects.toThrow(/no sender/);
      expect(fetchMock.calls).toHaveLength(0);
    });
  });
});
