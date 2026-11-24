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
      // The attachment surfaces on the normalized message with its bytes:
      // an email carries its files, nothing is fetched.
      expect(r.attachments).toEqual([
        { type: 'application/pdf', name: 'doc.pdf', size: 8, data: Buffer.from('%PDF-1.4') },
      ]);
      // The bytes do not ride in metadata, which travels with the reply.
      expect(r.metadata?.attachments[0].content).toBeUndefined();
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
        { type: 'image/png', name: 'logo.png', size: 8, data: Buffer.from('iVBORw0KGgo=', 'base64') },
      ]);
      const att = r.metadata?.attachments[0];
      expect(att.contentType).toBe('image/png');
      expect(att.contentId).toBe('logo123');
      expect(att.disposition).toBe('inline');
    });
  });

  describe('formatOutbound', () => {
    // The scheduled morning brief as the agent wrote it, with the
    // disclosure line the channel puts first. It arrived with its table as
    // rows of pipes.
    const disclosure = 'You are chatting with an AI assistant.';
    const brief = [
      disclosure,
      '',
      '# Morning brief: Tue 24 Nov',
      '',
      '## 2. Today\'s meetings',
      '| Time | Meeting | Calendar |',
      '|---|---|---|',
      '| 11:00–11:45 | Intro call: Priya Raman, **external** | Work |',
      '| 12:00–12:30 | Weekly pipeline review | Work |',
      '',
      '## 3. Tasks',
      '- **Approve payroll** (Work), *4 days late*',
      '- Renew passport, see `passport.pdf`',
      '',
      '1. First',
      '2. Second',
    ].join('\n');

    it('produces both html and text fields', () => {
      const out = adapter.formatOutbound({ text: 'reply' });
      expect(Object.keys(out).sort()).toEqual(['html', 'text']);
      expect(out.text).toBe('reply');
      expect(out.html).toContain('<p style="margin:0 0 12px;">reply</p>');
    });

    it('renders a markdown table as a real table, with no pipes left', () => {
      const { html } = adapter.formatOutbound({ text: brief });
      expect(html).toMatch(/<table style="[^"]*border-collapse:collapse[^"]*">/);
      expect(html).toContain('<th style="');
      expect(html).toMatch(/<td style="[^"]*">11:00–11:45<\/td>/);
      expect(html).toMatch(/<td style="[^"]*">Intro call: Priya Raman, <strong>external<\/strong><\/td>/);
      expect(html).not.toContain('|');
      // A wide table scrolls in its own box instead of widening the mail.
      expect(html).toContain('overflow-x:auto');
    });

    it('renders headings, lists, emphasis and code in a column readable on a phone, all styled inline', () => {
      const { html } = adapter.formatOutbound({ text: brief });
      expect(html).toMatch(/<h1 style="[^"]*">Morning brief: Tue 24 Nov<\/h1>/);
      expect(html).toMatch(/<h2 style="[^"]*">2\. Today's meetings<\/h2>/);
      expect(html).toMatch(/<ul style="[^"]*">\n<li style="[^"]*"><strong>Approve payroll<\/strong> \(Work\), <em>4 days late<\/em><\/li>/);
      expect(html).toMatch(/<code style="[^"]*">passport\.pdf<\/code>/);
      expect(html).toMatch(/<ol style="[^"]*">/);
      expect(html).toContain('max-width:640px');
      expect(html).toContain('width="100%"');
      // Mail clients drop <style> blocks; nothing may depend on one.
      expect(html).not.toContain('<style');
      expect(html).not.toMatch(/>#+ /);
      expect(html).not.toContain('**');
    });

    it('sends a plain-text part with each table row on a line of its own and the markers out', () => {
      const { text } = adapter.formatOutbound({ text: brief });
      expect(text).toContain('Time · Meeting · Calendar\n- 11:00–11:45 · Intro call: Priya Raman, external · Work\n- 12:00–12:30 · Weekly pipeline review · Work');
      expect(text).toContain('- Approve payroll (Work), 4 days late\n- Renew passport, see passport.pdf');
      expect(text).toContain('1. First\n2. Second');
      expect(text).toContain('Morning brief: Tue 24 Nov');
      expect(text).not.toMatch(/[|*#`]/);
    });

    it('keeps the AI disclosure, first and as written, in both parts', () => {
      const { html, text } = adapter.formatOutbound({ text: brief });
      expect(text.startsWith(`${disclosure}\n\n`)).toBe(true);
      expect(html).toMatch(new RegExp(`^<table[^>]*><tr><td[^>]*><div[^>]*><p style="[^"]*">${disclosure.replace(/\./g, '\\.')}</p>`));
    });

    it('escapes markup in the answer and drops script links', () => {
      const out = adapter.formatOutbound({
        text: 'Intro <Kestrel> & co\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1)) [ok](https://example.com/a?b=1&c=2)\n![pixel](https://track.example/p.gif)',
      });
      expect(out.html).toContain('Intro &lt;Kestrel&gt; &amp; co');
      expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(out.html).not.toContain('<script');
      expect(out.html).not.toContain('<img');
      expect(out.html).not.toMatch(/href="javascript:/i);
      expect(out.html).toMatch(/<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" style="[^"]*">ok<\/a>/);
      expect(out.text).toContain('Intro <Kestrel> & co');
      expect(out.text).toContain('ok (https://example.com/a?b=1&c=2)');
    });

    it('shows the answer\'s markdown as formatting, and leaves the markers out of the text part', () => {
      const out = adapter.formatOutbound({ text: '## Your brief\n**Conflicts**: two\nSee [the calendar](https://calendar.example.com)' });
      expect(out.html).toMatch(/<h2 style="[^"]*">Your brief<\/h2>\n<p style="[^"]*"><strong>Conflicts<\/strong>: two<br>\nSee <a href="https:\/\/calendar\.example\.com" style="[^"]*">the calendar<\/a><\/p>/);
      expect(out.text).toBe('Your brief\n\nConflicts: two\nSee the calendar (https://calendar.example.com)');
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
        text: 'reply',
      });
    });
    it('refuses rather than skipping when resend_api_key is missing', async () => {
      // Nothing was sent, so nothing may be recorded as sent.
      await expect(
        adapter.sendResponse({}, { html: 'r', text: 'r' }, { from: 'a@b', subject: 's' }),
      ).rejects.toThrow(/resend_api_key is not configured/);
      expect(fetchMock.calls.length).toBe(0);
    });

    it('refuses when the inbound mail gave no address to reply to', async () => {
      await expect(
        adapter.sendResponse({ resend_api_key: 're_test' }, { html: 'r', text: 'r' }, { subject: 's' }),
      ).rejects.toThrow(/no address to reply to/);
      expect(fetchMock.calls.length).toBe(0);
    });

    /**
     * Resend refuses with a status and `{name, message}`. An unverified
     * sending domain is the common one, and it used to be logged as a
     * reply the customer received.
     */
    it('refuses a Resend rejection and keeps its message and name', async () => {
      fetchMock.setNextResponse({
        ok: false,
        status: 403,
        json: { statusCode: 403, name: 'validation_error', message: 'The almyty.com domain is not verified' },
      });
      await expect(adapter.sendResponse(
        { resend_api_key: 're_test', reply_from: 'bot@almyty.com' },
        { html: 'r', text: 'r' },
        { from: 'a@b', subject: 's' },
      )).rejects.toThrow(/domain is not verified.*validation_error/);
    });

    it('never puts the API key in the failure it reports', async () => {
      fetchMock.setNextResponse({ ok: false, status: 401, json: { name: 'invalid_api_key', message: 'API key is invalid' } });
      const error = await adapter.sendResponse(
        { resend_api_key: 're_live_super_secret', reply_from: 'bot@almyty.com' },
        { html: 'r', text: 'r' },
        { from: 'a@b', subject: 's' },
      ).then(() => null, (e) => e);
      expect(error).toBeTruthy();
      expect(error.message).not.toContain('re_live_super_secret');
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

    it('refuses inbound when no signing secret is configured', async () => {
      await expect(adapter.verifyWebhook({ a: 1 }, {}, {})).resolves.toBe(false);
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
