import * as crypto from 'crypto';
import { WhatsAppCloudAdapter } from '../whatsapp-cloud.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

/**
 * Meta WhatsApp Cloud API adapter. Inbound payloads follow the Graph
 * webhooks envelope (entry[].changes[].value.messages[]), signed with
 * X-Hub-Signature-256 (HMAC-SHA256 of the raw body with app_secret).
 * The GET hub.challenge verification handshake is a static helper the
 * unified delegation calls before signature verification applies.
 */

const APP_SECRET = 'meta-app-secret';

const inboundPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15559999999', phone_number_id: 'PNID-1' },
            contacts: [{ profile: { name: 'Ada' }, wa_id: '15551234567' }],
            messages: [
              {
                from: '15551234567',
                id: 'wamid.abc',
                timestamp: '1720000000',
                type: 'text',
                text: { body: 'hello agent' },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('WhatsAppCloudAdapter', () => {
  let adapter: WhatsAppCloudAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new WhatsAppCloudAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('parses entry/changes/value/messages into normalized form', () => {
      const r = adapter.normalizeInbound(inboundPayload);
      expect(r.text).toBe('hello agent');
      expect(r.userId).toBe('15551234567');
      expect(r.threadId).toBe('15551234567');
      expect(r.metadata?.messageId).toBe('wamid.abc');
      expect(r.metadata?.phoneNumberId).toBe('PNID-1');
      expect(r.metadata?.profileName).toBe('Ada');
      expect(r.metadata?.source).toBe('whatsapp_cloud');
    });

    it('handles status-only payloads (no messages) without throwing', () => {
      const statusOnly = {
        entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.x', status: 'delivered' }] } }] }],
      };
      const r = adapter.normalizeInbound(statusOnly);
      expect(r.text).toBe('');
      expect(r.userId).toBe('unknown');
    });

    it('handles a completely empty payload', () => {
      const r = adapter.normalizeInbound({});
      expect(r.text).toBe('');
      expect(r.userId).toBe('unknown');
    });
  });

  describe('sendResponse (Graph API outbound)', () => {
    it('POSTs the Cloud API message payload shape with bearer auth', async () => {
      await adapter.sendResponse(
        { access_token: 'EAAG-token', phone_number_id: 'PNID-1' },
        { body: 'reply text' },
        { from: '15551234567' },
      );
      expect(fetchMock.calls[0].url).toBe('https://graph.facebook.com/v20.0/PNID-1/messages');
      expect(fetchMock.calls[0].init.headers['Authorization']).toBe('Bearer EAAG-token');
      expect(fetchMock.calls[0].init.method).toBe('POST');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({
        messaging_product: 'whatsapp',
        to: '15551234567',
        text: { body: 'reply text' },
      });
    });

    it('falls back to threadId as the recipient', async () => {
      await adapter.sendResponse(
        { access_token: 't', phone_number_id: 'PNID-1' },
        { body: 'x' },
        { threadId: '15551234567' },
      );
      expect(parseSentJson(fetchMock.calls[0]).to).toBe('15551234567');
    });

    it('swallows errors', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('graph down'));
      await expect(adapter.sendResponse(
        { access_token: 't', phone_number_id: 'p' },
        { body: 'x' },
        { from: '1' },
      )).resolves.toBeUndefined();
    });
  });

  describe('verifyWebhook (X-Hub-Signature-256)', () => {
    const config = { app_secret: APP_SECRET };
    const sign = (raw: string) =>
      'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw, 'utf-8').digest('hex');

    it('accepts a correctly signed raw body', async () => {
      const raw = JSON.stringify(inboundPayload);
      const ok = await adapter.verifyWebhook(
        inboundPayload,
        { 'x-hub-signature-256': sign(raw) },
        config,
        raw,
      );
      expect(ok).toBe(true);
    });

    it('rejects a tampered raw body', async () => {
      const raw = JSON.stringify(inboundPayload);
      const ok = await adapter.verifyWebhook(
        inboundPayload,
        { 'x-hub-signature-256': sign(raw) },
        config,
        raw.replace('hello agent', 'attacker text'),
      );
      expect(ok).toBe(false);
    });

    it('rejects when the signature header is missing', async () => {
      const raw = JSON.stringify(inboundPayload);
      const ok = await adapter.verifyWebhook(inboundPayload, {}, config, raw);
      expect(ok).toBe(false);
    });

    it('skips verification when app_secret is not configured', async () => {
      const ok = await adapter.verifyWebhook(inboundPayload, {}, {}, '{}');
      expect(ok).toBe(true);
    });
  });

  describe('handleVerification (GET hub.challenge handshake)', () => {
    const config = { verify_token: 'my-verify-token' };

    it('echoes the challenge when mode and token match', () => {
      const out = WhatsAppCloudAdapter.handleVerification(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'my-verify-token', 'hub.challenge': '424242' },
        config,
      );
      expect(out).toBe('424242');
    });

    it('rejects a wrong verify token', () => {
      const out = WhatsAppCloudAdapter.handleVerification(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
        config,
      );
      expect(out).toBeNull();
    });

    it('rejects a non-subscribe mode', () => {
      const out = WhatsAppCloudAdapter.handleVerification(
        { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'my-verify-token', 'hub.challenge': '1' },
        config,
      );
      expect(out).toBeNull();
    });

    it('rejects when no verify_token is configured (never open by default)', () => {
      const out = WhatsAppCloudAdapter.handleVerification(
        { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' },
        {},
      );
      expect(out).toBeNull();
    });
  });
});
