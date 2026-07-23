import * as crypto from 'crypto';
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
      // Thread key = normalized sender + references-root (here: own Message-ID)
      expect(r.threadId).toBe('alice@example.com:<m1@example.com>');
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
      expect(r.threadId).toBe('alice@example.com:<m1@example.com>');
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
      expect(r.threadId).toBe('alice@example.com:<m1@example.com>');
      expect(r.metadata?.messageId).toBe('<m3@example.com>');
      expect(r.metadata?.subject).toBe('a subject folded across two lines');
    });

    it('handles nested multipart (mixed containing alternative) and captures attachment metadata', () => {
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
        'Content-Disposition: attachment; filename="doc.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQ=',
        '--OUTER--',
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      // The text body still wins even with a trailing attachment part.
      expect(r.text).toBe('nested plain body');
      // Attachment metadata surfaces on the normalized message.
      expect(r.attachments).toEqual([
        { url: '', type: 'application/pdf', name: 'doc.pdf' },
      ]);
      // Richer per-part detail (size, disposition) rides in metadata.
      expect(r.metadata?.attachments).toHaveLength(1);
      const att = r.metadata?.attachments[0];
      expect(att.contentType).toBe('application/pdf');
      expect(att.filename).toBe('doc.pdf');
      expect(att.disposition).toBe('attachment');
      // base64 "JVBERi0xLjQ=" decodes to the 8-byte "%PDF-1.4".
      expect(att.size).toBe(8);
    });

    it('leaves attachments undefined for a plain text-only message', () => {
      const mime = [
        'From: eve@example.com',
        'Subject: no files',
        'Content-Type: text/plain',
        '',
        'just text',
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      expect(r.attachments).toBeUndefined();
      expect(r.metadata?.attachments).toEqual([]);
    });

    it('captures an inline image attachment with its content-id', () => {
      const mime = [
        'From: frank@example.com',
        'Subject: inline',
        'Content-Type: multipart/related; boundary="REL"',
        '',
        '--REL',
        'Content-Type: text/html',
        '',
        '<p>see <img src="cid:logo123"></p>',
        '--REL',
        'Content-Type: image/png; name="logo.png"',
        'Content-Disposition: inline; filename="logo.png"',
        'Content-ID: <logo123>',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--REL--',
      ].join('\r\n');
      const r = adapter.normalizeInbound(mime);
      expect(r.attachments).toEqual([
        { url: '', type: 'image/png', name: 'logo.png' },
      ]);
      const att = r.metadata?.attachments[0];
      expect(att.contentType).toBe('image/png');
      expect(att.contentId).toBe('logo123');
      expect(att.disposition).toBe('inline');
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

  describe('normalizeInbound — Resend inbound events (email.received)', () => {
    const resendEvent = {
      type: 'email.received',
      created_at: '2026-07-02T10:00:00.000Z',
      data: {
        email_id: 'inbound-1',
        from: 'Alice <alice@example.com>',
        to: ['support-bot@inbound.almyty.example'],
        subject: 'help me',
        text: 'plain body',
        html: '<p>plain body</p>',
        headers: [
          { name: 'Message-ID', value: '<m1@example.com>' },
          { name: 'X-Irrelevant', value: 'x' },
        ],
      },
    };

    it('unwraps the nested data payload to a normalized message', () => {
      const r = adapter.normalizeInbound(resendEvent);
      expect(r.text).toBe('plain body');
      expect(r.userId).toBe('Alice <alice@example.com>');
      expect(r.threadId).toBe('alice@example.com:<m1@example.com>');
      expect(r.metadata?.subject).toBe('help me');
      expect(r.metadata?.to).toBe('support-bot@inbound.almyty.example');
      expect(r.metadata?.messageId).toBe('<m1@example.com>');
      expect(r.metadata?.source).toBe('email');
    });

    it('threads a Resend reply into the original conversation via the References root', () => {
      const reply = {
        type: 'email.received',
        data: {
          from: 'alice@example.com',
          to: ['support-bot@inbound.almyty.example'],
          subject: 'Re: help me',
          text: 'thanks, one more thing',
          headers: [
            { name: 'Message-ID', value: '<m9@example.com>' },
            // Replying to the agent's reply: In-Reply-To points at the
            // agent's message, References still roots at <m1>.
            { name: 'In-Reply-To', value: '<agent-reply@resend>' },
            { name: 'References', value: '<m1@example.com> <agent-reply@resend>' },
          ],
        },
      };
      const original = adapter.normalizeInbound(resendEvent);
      const r = adapter.normalizeInbound(reply);
      expect(r.threadId).toBe('alice@example.com:<m1@example.com>');
      expect(r.threadId).toBe(original.threadId);
      expect(r.metadata?.references).toBe('<m1@example.com> <agent-reply@resend>');
    });

    it('parses raw MIME carried inside the event data', () => {
      const mime = [
        'From: Alice <alice@example.com>',
        'To: support-bot@inbound.almyty.example',
        'Subject: help me',
        'Message-ID: <m1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'raw mime body',
      ].join('\r\n');
      const r = adapter.normalizeInbound({ type: 'email.received', data: { raw: mime } });
      expect(r.text).toBe('raw mime body');
      expect(r.threadId).toBe('alice@example.com:<m1@example.com>');
    });

    it('reads headers delivered as an object map too', () => {
      const r = adapter.normalizeInbound({
        type: 'email.received',
        data: {
          from: 'bob@example.com',
          subject: 's',
          text: 't',
          headers: { 'Message-Id': '<map@example.com>' },
        },
      });
      expect(r.threadId).toBe('bob@example.com:<map@example.com>');
    });
  });

  describe('extractRecipients', () => {
    it('collects bare lowercase addresses from Resend events, JSON and raw MIME', () => {
      expect(
        EmailAdapter.extractRecipients({
          type: 'email.received',
          data: { to: ['Support <Support-Bot@Inbound.Almyty.example>'], cc: 'x@y.example' },
        }),
      ).toEqual(['support-bot@inbound.almyty.example', 'x@y.example']);

      expect(EmailAdapter.extractRecipients({ to: 'a@b.example, C <c@d.example>' })).toEqual([
        'a@b.example',
        'c@d.example',
      ]);

      const mime = ['To: bot@inbound.example', 'From: a@b', 'Subject: s', '', 'body'].join('\r\n');
      expect(EmailAdapter.extractRecipients(mime)).toEqual(['bot@inbound.example']);
    });

    it('returns [] when nothing resolvable is present', () => {
      expect(EmailAdapter.extractRecipients({})).toEqual([]);
      expect(EmailAdapter.extractRecipients(null)).toEqual([]);
    });
  });

  describe('verifyWebhook — svix signature', () => {
    const secretBytes = Buffer.from('email-adapter-test-secret');
    const secret = `whsec_${secretBytes.toString('base64')}`;
    const svixHeaders = (rawBody: string, id = 'msg_1') => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .createHmac('sha256', secretBytes)
        .update(`${id}.${timestamp}.${rawBody}`)
        .digest('base64');
      return {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${signature}`,
      };
    };

    it('accepts everything when no secret is configured (legacy behavior)', async () => {
      await expect(adapter.verifyWebhook({ a: 1 }, {}, {})).resolves.toBe(true);
    });

    it('accepts a correctly signed raw body', async () => {
      const rawBody = JSON.stringify({ type: 'email.received', data: { text: 'hi' } });
      await expect(
        adapter.verifyWebhook(
          JSON.parse(rawBody),
          svixHeaders(rawBody),
          { resend_inbound_signing_secret: secret },
          rawBody,
        ),
      ).resolves.toBe(true);
    });

    it('rejects a tampered body and missing svix headers', async () => {
      const rawBody = JSON.stringify({ data: { text: 'hi' } });
      const headers = svixHeaders(rawBody);
      await expect(
        adapter.verifyWebhook({}, headers, { resend_inbound_signing_secret: secret }, rawBody + 'x'),
      ).resolves.toBe(false);
      await expect(
        adapter.verifyWebhook({}, {}, { resend_inbound_signing_secret: secret }, rawBody),
      ).resolves.toBe(false);
    });
  });

  describe('sendResponse — reply threading', () => {
    it('sets In-Reply-To/References from the inbound message and Reply-To to the inbound address', async () => {
      await adapter.sendResponse(
        { resend_api_key: 're_test', inbound_address: 'support-bot@inbound.almyty.example' },
        { html: 'reply', text: 'reply' },
        {
          from: 'alice@example.com',
          subject: 'help me',
          metadata: {
            messageId: '<m9@example.com>',
            references: '<m1@example.com> <agent-reply@resend>',
          },
        },
      );
      const body = parseSentJson(fetchMock.calls[0]);
      expect(body.from).toBe('support-bot@inbound.almyty.example');
      expect(body.reply_to).toBe('support-bot@inbound.almyty.example');
      expect(body.subject).toBe('Re: help me');
      expect(body.headers).toEqual({
        'In-Reply-To': '<m9@example.com>',
        References: '<m1@example.com> <agent-reply@resend> <m9@example.com>',
      });
    });

    it('starts References at the inbound Message-ID when the first mail has no chain', async () => {
      await adapter.sendResponse(
        { resend_api_key: 're_test', reply_from: 'bot@almyty.com' },
        { html: 'reply', text: 'reply' },
        { from: 'alice@example.com', subject: 'help me', metadata: { messageId: '<m1@example.com>' } },
      );
      const body = parseSentJson(fetchMock.calls[0]);
      expect(body.headers).toEqual({
        'In-Reply-To': '<m1@example.com>',
        References: '<m1@example.com>',
      });
    });

    it('does not stack Re: prefixes on replies to replies', async () => {
      await adapter.sendResponse(
        { resend_api_key: 're_test', reply_from: 'bot@almyty.com' },
        { html: 'reply', text: 'reply' },
        { from: 'alice@example.com', subject: 'Re: help me' },
      );
      const body = parseSentJson(fetchMock.calls[0]);
      expect(body.subject).toBe('Re: help me');
    });
  });
});
