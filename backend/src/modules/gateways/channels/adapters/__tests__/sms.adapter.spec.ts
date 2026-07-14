import { SmsAdapter } from '../sms.adapter';
import { installFetchMock, parseSentForm } from './test-helpers';

const twilioPayload = {
  Body: 'hello agent',
  From: '+15551234567',
  To: '+15559999999',
  MessageSid: 'SM456',
  AccountSid: 'AC123',
};

describe('SmsAdapter', () => {
  let adapter: SmsAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new SmsAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts Body/From/MessageSid from the Twilio SMS payload', () => {
      const r = adapter.normalizeInbound(twilioPayload);
      expect(r.text).toBe('hello agent');
      expect(r.userId).toBe('+15551234567');
      expect(r.threadId).toBe('+15551234567');
      expect(r.metadata?.from).toBe('+15551234567');
      expect(r.metadata?.to).toBe('+15559999999');
      expect(r.metadata?.messageSid).toBe('SM456');
      expect(r.metadata?.source).toBe('sms');
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
    it('POSTs to Twilio Messages with Basic auth, bare E.164 From/To', async () => {
      await adapter.sendResponse(
        {
          twilio_account_sid: 'AC_TEST',
          twilio_auth_token: 'auth_test',
          phone_number: '+15559999999',
        },
        { body: 'reply' },
        { from: '+15551234567' },
      );
      expect(fetchMock.calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_TEST/Messages.json');
      const auth = fetchMock.calls[0].init.headers['Authorization'];
      const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf-8');
      expect(decoded).toBe('AC_TEST:auth_test');
      const form = parseSentForm(fetchMock.calls[0]);
      // No whatsapp: prefix — plain SMS numbers.
      expect(form.From).toBe('+15559999999');
      expect(form.To).toBe('+15551234567');
      expect(form.Body).toBe('reply');
    });

    it('falls back to threadId as the recipient (service dispatch shape)', async () => {
      await adapter.sendResponse(
        { twilio_account_sid: 'AC_TEST', twilio_auth_token: 't', phone_number: '+15559999999' },
        { body: 'reply' },
        { threadId: '+15551234567', userId: '+15551234567' },
      );
      const form = parseSentForm(fetchMock.calls[0]);
      expect(form.To).toBe('+15551234567');
    });

    it('truncates bodies past the 1600-char Twilio segment limit', async () => {
      await adapter.sendResponse(
        { twilio_account_sid: 'AC_TEST', twilio_auth_token: 't', phone_number: '+1' },
        { body: 'x'.repeat(2000) },
        { from: '+2' },
      );
      const form = parseSentForm(fetchMock.calls[0]);
      expect(form.Body).toHaveLength(1600);
    });

    it('swallows errors', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('x'));
      await expect(adapter.sendResponse(
        { twilio_account_sid: 'a', twilio_auth_token: 'b', phone_number: '+1' },
        { body: 'x' },
        { from: '+2' },
      )).resolves.toBeUndefined();
    });
  });

  describe('verifyWebhook (X-Twilio-Signature — shared helper)', () => {
    const crypto = require('crypto');
    const authToken = 'twilio-auth-token';
    const webhookUrl = 'https://api.example.com/acme/sms-line';
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

    it('skips verification when webhook_url is not configured', async () => {
      const ok = await adapter.verifyWebhook(twilioPayload, {}, { twilio_auth_token: authToken });
      expect(ok).toBe(true);
    });

    it('skips verification when twilio_auth_token is not configured', async () => {
      const ok = await adapter.verifyWebhook(twilioPayload, {}, { webhook_url: webhookUrl });
      expect(ok).toBe(true);
    });
  });
});
