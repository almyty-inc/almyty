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
    it('swallows errors', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('x'));
      await expect(adapter.sendResponse(
        { twilio_account_sid: 'a', twilio_auth_token: 'b', phone_number: '+1' },
        { body: 'x' },
        { from: 'whatsapp:+2' },
      )).resolves.toBeUndefined();
    });
  });
});
