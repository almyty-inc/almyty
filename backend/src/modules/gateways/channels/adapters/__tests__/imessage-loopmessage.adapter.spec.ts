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

/**
 * A group message with a photo: the webhook doc's optional `group`
 * (`id`, `name`, `participants`) and `attachments` (an array of download
 * URLs) fields.
 */
const groupWebhook = {
  ...inboundWebhook,
  contact: '+13231114455',
  text: 'Is this the right mug?',
  message_type: 'attachments',
  message_id: 'GRP-59c55Ce8',
  group: { id: '7e0b1f4a-group', name: 'Northwind ops', participants: ['+13231112233', '+13231114455'] },
  attachments: ['https://cdn.loopmessage.com/attachments/abc/mug.jpeg'],
};

const config = { api_key: 'loop-api-key', inbound_token: 'loop-webhook-auth-0001', sender_name: 'northwind' };

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
      expect(r.attachments).toBeUndefined();
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

    it('answers message_inbound with text or files, one to one or in a group, and no other event', () => {
      expect(adapter.carriesMessage(inboundWebhook)).toBe(true);
      for (const event of ['message_sent', 'message_delivered', 'message_failed', 'message_reaction', 'message_scheduled']) {
        expect(adapter.carriesMessage({ ...inboundWebhook, event })).toBe(false);
      }
      expect(adapter.carriesMessage(groupWebhook)).toBe(true);
      expect(adapter.carriesMessage({ ...groupWebhook, text: '' })).toBe(true);
      expect(adapter.carriesMessage({ ...inboundWebhook, text: '' })).toBe(false);
      expect(adapter.carriesMessage({ ...inboundWebhook, text: '', attachments: ['http://10.0.0.1/a.png'] })).toBe(false);
      expect(adapter.carriesMessage({ ...inboundWebhook, contact: undefined })).toBe(false);
    });
  });

  describe('group chats', () => {
    it('keys the conversation on the group and the sender on the member who wrote', () => {
      const r = adapter.normalizeInbound(groupWebhook);
      expect(r.threadId).toBe('7e0b1f4a-group');
      expect(r.userId).toBe('+13231114455');
      expect(r.metadata).toMatchObject({ groupId: '7e0b1f4a-group', groupName: 'Northwind ops', from: '+13231114455' });
    });

    it('replies to the group, not to the member', async () => {
      const r = adapter.normalizeInbound(groupWebhook);
      await adapter.sendResponse(config, adapter.formatOutbound({ text: 'Yes, that one.' }), {
        ...r.metadata,
        threadId: r.threadId,
        from: r.metadata?.from,
      });
      expect(parseSentJson(fetchMock.calls[0])).toEqual({ group: '7e0b1f4a-group', text: 'Yes, that one.', sender: 'northwind' });
    });
  });

  describe('attachments', () => {
    it('hands inbound attachment URLs over, https only', () => {
      const r = adapter.normalizeInbound({
        ...groupWebhook,
        attachments: [...groupWebhook.attachments, 'http://cdn.example/plain.png', 42, 'https://cdn.example/voice.m4a'],
      });
      expect(r.attachments).toEqual([
        { url: 'https://cdn.loopmessage.com/attachments/abc/mug.jpeg', type: 'image/jpeg', name: 'mug.jpeg' },
        { url: 'https://cdn.example/voice.m4a', type: 'audio/mp4', name: 'voice.m4a' },
      ]);
    });

    it('sends reply files as `attachments`, at most ten, https and at most 256 characters each', async () => {
      const files = [
        { url: 'http://files.example/plain.jpg', type: 'image/jpeg', name: 'plain.jpg' },
        { url: `https://files.example/${'a'.repeat(300)}.jpg`, type: 'image/jpeg', name: 'long.jpg' },
        ...Array.from({ length: 12 }, (_, i) => ({ url: `https://files.example/${i}.jpg`, type: 'image/jpeg', name: `${i}.jpg` })),
      ];
      await adapter.sendResponse(config, adapter.formatOutbound({ text: 'Photos.', attachments: files }), { from: '+13231112233' });
      const sent = parseSentJson(fetchMock.calls[0]);
      expect(sent.attachments).toEqual(Array.from({ length: 10 }, (_, i) => `https://files.example/${i}.jpg`));
      expect(sent).toMatchObject({ contact: '+13231112233', text: 'Photos.', sender: 'northwind' });
    });

    it('sends no attachments field when the reply has no files', () => {
      expect(adapter.formatOutbound({ text: 'x' })).toEqual({ text: 'x' });
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
    it('POSTs message/send with the bare API key as Authorization, from the sender name', async () => {
      fetchMock.setNextResponse({ json: { message_id: 'OUT-1', contact: '+13231112233', text: 'Hi' } });
      await adapter.sendResponse(config, adapter.formatOutbound({ text: 'Hi' }), { from: '+13231112233' });

      const call = fetchMock.calls[0];
      expect(call.url).toBe('https://a.loopmessage.com/api/v1/message/send/');
      expect(call.init.method).toBe('POST');
      expect(call.init.headers).toMatchObject({ Authorization: 'loop-api-key', 'Content-Type': 'application/json' });
      expect(parseSentJson(call)).toEqual({ contact: '+13231112233', text: 'Hi', sender: 'northwind' });
    });

    it('refuses before calling out without a sender name', async () => {
      const { sender_name: _unset, ...unnamed } = config;
      await expect(adapter.sendResponse(unnamed, { text: 'x' }, { from: '+1' })).rejects.toThrow(/sender_name/);
      await expect(adapter.sendResponse({ ...config, sender_name: '   ' }, { text: 'x' }, { from: '+1' })).rejects.toThrow(/sender_name/);
      expect(fetchMock.calls).toHaveLength(0);
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
      await expect(adapter.sendResponse({ inbound_token: 't', sender_name: 'n' }, { text: 'x' }, { from: '+1' })).rejects.toThrow(/api_key/);
      await expect(adapter.sendResponse(config, { text: 'x' }, {})).rejects.toThrow(/no sender/);
      expect(fetchMock.calls).toHaveLength(0);
    });
  });
});
