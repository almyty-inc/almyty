import { WhatsAppAdapter } from '../whatsapp.adapter';
import { installFetchMock, parseSentForm } from './test-helpers';

const twilioPayload = {
  Body: 'hello agent',
  From: 'whatsapp:+15551234567',
  To: 'whatsapp:+15559999999',
  MessageSid: 'SM123',
  AccountSid: 'AC123',
};

describe('WhatsAppAdapter', () => {
  let adapter: WhatsAppAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new WhatsAppAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts Body/From/MessageSid from Twilio payload', () => {
      const r = adapter.normalizeInbound(twilioPayload);
      expect(r.text).toBe('hello agent');
      expect(r.userId).toBe('whatsapp:+15551234567');
      expect(r.threadId).toBe('whatsapp:+15551234567');
      expect(r.metadata?.from).toBe('whatsapp:+15551234567');
      expect(r.metadata?.messageSid).toBe('SM123');
      expect(r.metadata?.source).toBe('whatsapp');
    });
    it('handles missing fields', () => {
      const r = adapter.normalizeInbound({});
      expect(r.text).toBe('');
      expect(r.userId).toBe('unknown');
    });
  });

  describe('formatOutbound', () => {
    it('produces {body} payload', () => {
      expect(adapter.formatOutbound({ text: 'reply' })).toEqual({ body: 'reply' });
    });
  });

  describe('sendResponse', () => {
    it('POSTs to Twilio Messages with Basic auth and form-encoded body', async () => {
      await adapter.sendResponse(
        {
          twilio_account_sid: 'AC_TEST',
          twilio_auth_token: 'auth_test',
          phone_number: '+15559999999',
        },
        { body: 'reply' },
        { from: 'whatsapp:+15551234567' },
      );
      expect(fetchMock.calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_TEST/Messages.json');
      const auth = fetchMock.calls[0].init.headers['Authorization'];
      expect(auth).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
      const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf-8');
      expect(decoded).toBe('AC_TEST:auth_test');
      const form = parseSentForm(fetchMock.calls[0]);
      expect(form.From).toBe('whatsapp:+15559999999');
      expect(form.To).toBe('whatsapp:+15551234567');
      expect(form.Body).toBe('reply');
    });
    /**
     * Twilio refuses with an HTTP status and a `{code, message}` body.
     * An opt-out, a number Twilio will not parse, a WhatsApp message
     * past the 24-hour session window: all of them used to be filed as
     * a reply the customer received.
     */
    it('refuses a non-2xx and keeps Twilio\'s message and code', async () => {
      fetchMock.setNextResponse({
        ok: false,
        status: 400,
        json: { code: 63016, message: 'Failed to send freeform message because you are outside the allowed window', status: 400 },
      });
      await expect(adapter.sendResponse(
        { twilio_account_sid: 'a', twilio_auth_token: 'b', phone_number: '+1' },
        { body: 'x' },
        { from: 'whatsapp:+2' },
      )).rejects.toThrow(/outside the allowed window.*63016/);
    });

    it('refuses a created message Twilio already marked failed', async () => {
      // Twilio can take the message and report the failure on the same
      // response, via error_code on an otherwise-2xx create.
      fetchMock.setNextResponse({
        ok: true,
        status: 201,
        json: { sid: 'SM1', status: 'failed', error_code: 63024, error_message: 'Invalid message recipient' },
      });
      await expect(adapter.sendResponse(
        { twilio_account_sid: 'a', twilio_auth_token: 'b', phone_number: '+1' },
        { body: 'x' },
        { from: 'whatsapp:+2' },
      )).rejects.toThrow(/Invalid message recipient/);
    });

    it('does not swallow a network failure', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('x'));
      await expect(adapter.sendResponse(
        { twilio_account_sid: 'a', twilio_auth_token: 'b', phone_number: '+1' },
        { body: 'x' },
        { from: 'whatsapp:+2' },
      )).rejects.toThrow('x');
    });

    it('never puts the Twilio auth token in the failure it reports', async () => {
      fetchMock.setNextResponse({ ok: false, status: 401, json: { code: 20003, message: 'Authenticate' } });
      const error = await adapter.sendResponse(
        { twilio_account_sid: 'AC1', twilio_auth_token: 'super-secret-token', phone_number: '+1' },
        { body: 'x' },
        { from: 'whatsapp:+2' },
      ).then(() => null, (e) => e);
      expect(error).toBeTruthy();
      expect(error.message).not.toContain('super-secret-token');
    });
  });

  describe('sendResponse reply routing', () => {
    it('falls back to threadId as the recipient (service dispatch shape)', async () => {
      await adapter.sendResponse(
        { twilio_account_sid: 'AC_TEST', twilio_auth_token: 't', phone_number: '+15559999999' },
        { body: 'reply' },
        { threadId: 'whatsapp:+15551234567', userId: 'whatsapp:+15551234567' },
      );
      const form = parseSentForm(fetchMock.calls[0]);
      expect(form.To).toBe('whatsapp:+15551234567');
    });
  });

  describe('verifyWebhook (X-Twilio-Signature)', () => {
    const crypto = require('crypto');
    const authToken = 'twilio-auth-token';
    const webhookUrl = 'https://api.example.com/gateways/gw-1/webhook';
    const config = { twilio_auth_token: authToken, webhook_url: webhookUrl };

    const sign = (url: string, params: Record<string, string>) => {
      const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
      return crypto.createHmac('sha1', authToken).update(data, 'utf-8').digest('base64');
    };

    it('accepts a correctly signed request', async () => {
      const signature = sign(webhookUrl, twilioPayload as any);
      const ok = await adapter.verifyWebhook(twilioPayload, { 'x-twilio-signature': signature }, config);
      expect(ok).toBe(true);
    });

    it('rejects a tampered body', async () => {
      const signature = sign(webhookUrl, twilioPayload as any);
      const tampered = { ...twilioPayload, Body: 'attacker text' };
      const ok = await adapter.verifyWebhook(tampered, { 'x-twilio-signature': signature }, config);
      expect(ok).toBe(false);
    });

    it('rejects a signature computed for a different URL', async () => {
      const signature = sign('https://evil.example.com/other', twilioPayload as any);
      const ok = await adapter.verifyWebhook(twilioPayload, { 'x-twilio-signature': signature }, config);
      expect(ok).toBe(false);
    });

    it('rejects when the signature header is missing', async () => {
      const ok = await adapter.verifyWebhook(twilioPayload, {}, config);
      expect(ok).toBe(false);
    });

    it('refuses inbound when webhook_url is not configured', async () => {
      // Twilio signs the exact URL it called, so without webhook_url the
      // signature cannot be reconstructed and the request is refused.
      const ok = await adapter.verifyWebhook(twilioPayload, {}, { twilio_auth_token: authToken });
      expect(ok).toBe(false);
    });

    it('refuses inbound when twilio_auth_token is not configured', async () => {
      const ok = await adapter.verifyWebhook(twilioPayload, {}, { webhook_url: webhookUrl });
      expect(ok).toBe(false);
    });
  });
});
