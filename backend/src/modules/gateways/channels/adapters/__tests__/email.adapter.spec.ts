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
    it('strips html to text when text is missing', () => {
      const r = adapter.normalizeInbound({ html: '<p>Hello <b>there</b></p>', from: 'a@b' });
      expect(r.text).toBe('Hello there');
    });
  });

  describe('normalizeInbound — raw MIME payloads', () => {
    const simpleMime = [
      'From: Alice <alice@example.com>',
      'To: bot@almyty.com',
      'Subject: help me',
      'Message-ID: <m1@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello agent,',
      'please help.',
    ].join('\r\n');

    it('parses a raw MIME string payload', () => {
      const r = adapter.normalizeInbound(simpleMime);
      expect(r.text).toBe('Hello agent,\nplease help.');
      expect(r.userId).toBe('Alice <alice@example.com>');
      expect(r.threadId).toBe('<m1@example.com>');
      expect(r.metadata?.subject).toBe('help me');
      expect(r.metadata?.to).toBe('bot@almyty.com');
      expect(r.metadata?.source).toBe('email');
    });

    it('parses MIME delivered under a raw/mime/email JSON field', () => {
      for (const key of ['raw', 'mime', 'email']) {
        const r = adapter.normalizeInbound({ [key]: simpleMime });
        expect(r.text).toBe('Hello agent,\nplease help.');
        expect(r.userId).toBe('Alice <alice@example.com>');
      }
    });

    it('prefers text/plain in multipart/alternative and decodes quoted-printable', () => {
      const mime = [
        'From: bob@example.com',
        'Subject: multipart',
        'Message-ID: <m2@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="BOUND1"',
        '',
        'preamble to be ignored',
        '--BOUND1',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'caf=C3=A9 au lait =',
        'joined',
        '--BOUND1',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>caf&eacute; au lait <b>joined</b></p>',
        '--BOUND1--',
        'epilogue',
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      expect(r.text).toBe('café au lait joined');
    });

    it('decodes a base64 html-only message and strips it to text', () => {
      const html = '<html><body><p>Hi &amp; welcome</p><br><div>bye</div></body></html>';
      const mime = [
        'From: carol@example.com',
        'Subject: html only',
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(html, 'utf-8').toString('base64'),
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      expect(r.text).toBe('Hi & welcome\n\nbye');
    });

    it('decodes RFC 2047 encoded-word headers (B and Q)', () => {
      const b64Subject = `=?utf-8?B?${Buffer.from('héllo wörld', 'utf-8').toString('base64')}?=`;
      const mime = [
        `From: =?utf-8?Q?J=C3=BCrgen_M=C3=BCller?= <j@example.de>`,
        `Subject: ${b64Subject}`,
        'Content-Type: text/plain',
        '',
        'body',
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      expect(r.metadata?.subject).toBe('héllo wörld');
      expect(r.userId).toBe('Jürgen Müller <j@example.de>');
    });

    it('threads replies by In-Reply-To and unfolds folded headers', () => {
      const mime = [
        'From: alice@example.com',
        'Subject: a subject folded',
        ' across two lines',
        'Message-ID: <m3@example.com>',
        'In-Reply-To: <m1@example.com>',
        'Content-Type: text/plain',
        '',
        'reply body',
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      expect(r.threadId).toBe('<m1@example.com>');
      expect(r.metadata?.messageId).toBe('<m3@example.com>');
      expect(r.metadata?.subject).toBe('a subject folded across two lines');
    });

    it('handles nested multipart (mixed containing alternative) and skips attachments', () => {
      const mime = [
        'From: dave@example.com',
        'Subject: nested',
        'Content-Type: multipart/mixed; boundary="OUTER"',
        '',
        '--OUTER',
        'Content-Type: multipart/alternative; boundary="INNER"',
        '',
        '--INNER',
        'Content-Type: text/plain',
        '',
        'nested plain body',
        '--INNER',
        'Content-Type: text/html',
        '',
        '<p>nested html body</p>',
        '--INNER--',
        '--OUTER',
        'Content-Type: application/pdf; name="doc.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQ=',
        '--OUTER--',
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      expect(r.text).toBe('nested plain body');
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
