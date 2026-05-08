import { EmailAdapter } from '../email.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

describe('EmailAdapter', () => {
  let adapter: EmailAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new EmailAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts text/from/subject', () => {
      const r = adapter.normalizeInbound({
        text: 'plain body',
        from: 'alice@example.com',
        to: 'bot@almyty.com',
        subject: 'help me',
        messageId: '<m1@example.com>',
      });
      expect(r.text).toBe('plain body');
      expect(r.userId).toBe('alice@example.com');
      expect(r.threadId).toBe('<m1@example.com>');
      expect(r.metadata?.subject).toBe('help me');
      expect(r.metadata?.source).toBe('email');
    });
    it('uses html when text is missing', () => {
      const r = adapter.normalizeInbound({ html: '<b>hi</b>', from: 'a@b' });
      expect(r.text).toBe('<b>hi</b>');
    });
  });

  describe('formatOutbound', () => {
    it('produces both html and text fields', () => {
      expect(adapter.formatOutbound({ text: 'reply' })).toEqual({ html: 'reply', text: 'reply' });
    });
  });

  describe('sendResponse', () => {
    it('POSTs to Resend with bearer auth and Re: subject', async () => {
      await adapter.sendResponse(
        { resend_api_key: 're_test', reply_from: 'bot@almyty.com' },
        { html: 'reply', text: 'reply' },
        { from: 'alice@example.com', subject: 'help me' },
      );
      expect(fetchMock.calls[0].url).toBe('https://api.resend.com/emails');
      expect(fetchMock.calls[0].init.headers['Authorization']).toBe('Bearer re_test');
      const body = parseSentJson(fetchMock.calls[0]);
      expect(body).toEqual({
        from: 'bot@almyty.com',
        to: 'alice@example.com',
        subject: 'Re: help me',
        html: 'reply',
      });
    });
    it('skips when resend_api_key missing', async () => {
      await adapter.sendResponse({}, { html: 'r', text: 'r' }, { from: 'a@b', subject: 's' });
      expect(fetchMock.calls.length).toBe(0);
    });
  });
});
