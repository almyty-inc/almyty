import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import {
  htmlToText,
  looksLikeMime,
  parseMimeMessage,
  ParsedMimeAttachment,
} from './mime.helper';
import { verifySvixSignature } from './svix-signature.helper';

@Injectable()
export class EmailAdapter extends BaseAdapter {
  private readonly logger = new Logger(EmailAdapter.name);
  readonly type = 'email';

  // ---------------------------------------------------------------------------
  // Address / threading helpers (also used by the email provisioning
  // service and the global inbound controller)
  // ---------------------------------------------------------------------------

  /** Bare, lowercased address from `Name <a@b>` / `a@b` / `{ email }`. */
  static extractAddress(value: any): string | null {
    if (value && typeof value === 'object') {
      value = value.email || value.address || '';
    }
    if (typeof value !== 'string') return null;
    const angled = /<([^<>]+)>/.exec(value);
    const candidate = (angled ? angled[1] : value).trim().toLowerCase();
    return candidate.includes('@') ? candidate : null;
  }

  /**
   * Conversation key for a mail thread: `<sender>:<references-root>`.
   * The root of the References chain is stable across every message in
   * a thread (mail clients prepend the original Message-ID), so unlike
   * the previous In-Reply-To-based key it survives multi-hop replies —
   * a user replying to the agent's reply still lands in the same
   * conversation. The normalized sender disambiguates two threads that
   * would otherwise collide on the subject fallback.
   */
  static threadKey(from: any, root: string | undefined): string | undefined {
    const r = (root || '').trim();
    if (!r) return undefined;
    const sender = EmailAdapter.extractAddress(from);
    return sender ? `${sender}:${r}` : r;
  }

  /** First message-id in a References header — the thread root. */
  static referencesRoot(references: any): string | undefined {
    if (typeof references !== 'string') return undefined;
    return references.trim().split(/\s+/)[0] || undefined;
  }

  /**
   * Project parsed MIME attachment metadata onto the shared
   * NormalizedMessage attachment shape (`{ url, type, name }`). Inbound
   * MIME attachments carry no fetchable URL (we retain metadata only,
   * not the bytes), so `url` is left empty; richer detail (size,
   * contentId, disposition) rides along in message metadata.
   */
  static mapAttachments(
    attachments: ParsedMimeAttachment[] | undefined,
  ): Array<{ url: string; type: string; name: string }> {
    if (!Array.isArray(attachments)) return [];
    return attachments.map((a) => ({
      url: '',
      type: a.contentType,
      name: a.filename || '',
    }));
  }

  /**
   * Unwrap a provider webhook event envelope. Resend delivers inbound
   * mail as `{ type: 'email.received', created_at, data: {...} }` with
   * the message fields (headers/from/to/subject/text/html, raw MIME if
   * enabled) nested under `data`.
   */
  static unwrapEvent(rawPayload: any): any {
    if (
      rawPayload &&
      typeof rawPayload === 'object' &&
      typeof rawPayload.type === 'string' &&
      rawPayload.type.startsWith('email.') &&
      rawPayload.data &&
      typeof rawPayload.data === 'object'
    ) {
      return rawPayload.data;
    }
    return rawPayload;
  }

  /**
   * All recipient addresses in an inbound payload (Resend event, plain
   * JSON, or raw MIME) — used by the global fallback route to map a
   * delivery to the gateway owning that inbound address.
   */
  static extractRecipients(rawPayload: any): string[] {
    const payload = EmailAdapter.unwrapEvent(rawPayload);
    const rawMime = EmailAdapter.rawMimeOf(payload);
    const candidates: any[] = [];
    if (rawMime && looksLikeMime(rawMime)) {
      const parsed = parseMimeMessage(rawMime);
      candidates.push(parsed.to);
    }
    if (payload && typeof payload === 'object') {
      for (const field of ['to', 'cc', 'delivered_to', 'recipient']) {
        const value = (payload as any)[field];
        if (Array.isArray(value)) candidates.push(...value);
        else if (value) candidates.push(value);
      }
    }
    const addresses = new Set<string>();
    for (const candidate of candidates) {
      // A To header can carry several comma-separated mailboxes.
      const parts =
        typeof candidate === 'string' ? candidate.split(',') : [candidate];
      for (const part of parts) {
        const address = EmailAdapter.extractAddress(part);
        if (address) addresses.add(address);
      }
    }
    return [...addresses];
  }

  /** The raw MIME string of a payload, if it carries one. */
  private static rawMimeOf(payload: any): string | null {
    return typeof payload === 'string' ? payload
      : typeof payload?.raw === 'string' ? payload.raw
      : typeof payload?.mime === 'string' ? payload.mime
      : typeof payload?.email === 'string' ? payload.email
      : null;
  }

  /** Case-insensitive lookup over a headers array/map (Resend uses `[{ name, value }]`). */
  private static headerOf(headers: any, name: string): string | undefined {
    if (!headers) return undefined;
    if (Array.isArray(headers)) {
      const hit = headers.find(
        (h) => typeof h?.name === 'string' && h.name.toLowerCase() === name,
      );
      return typeof hit?.value === 'string' ? hit.value : undefined;
    }
    if (typeof headers === 'object') {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
      const value = key !== undefined ? headers[key] : undefined;
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
  }

  /**
   * Accepts three inbound shapes:
   *  1. A raw MIME message — either the whole payload as a string, or a
   *     `raw` / `mime` / `email` string field (SES SNS, Mailgun "raw",
   *     CloudMailin raw mode, etc.). Parsed in-tree (see mime.helper.ts):
   *     multipart, base64/quoted-printable, encoded-word headers, and
   *     HTML-to-text stripping are handled.
   *  2. A Resend inbound event (`{ type: 'email.received', data: {...} }`):
   *     unwrapped to `data`, then treated as raw MIME (when `data`
   *     carries one) or as pre-parsed JSON with a `headers` list.
   *  3. Pre-parsed JSON from an inbound-email webhook provider
   *     (SendGrid/Postmark/Resend style: text/html/body, from, subject,
   *     messageId). HTML-only payloads are stripped to text.
   *
   * threadId is the conversation key (see threadKey): every mail of a
   * thread — including replies to the agent's own replies — normalizes
   * to the same key, so a mail thread maps to one conversation.
   */
  normalizeInbound(rawPayload: any): NormalizedMessage {
    const unwrapped = EmailAdapter.unwrapEvent(rawPayload);
    const rawMime = EmailAdapter.rawMimeOf(unwrapped);

    if (rawMime && looksLikeMime(rawMime)) {
      const parsed = parseMimeMessage(rawMime);
      const root =
        EmailAdapter.referencesRoot(parsed.references) ||
        parsed.inReplyTo ||
        parsed.messageId;
      const attachments = EmailAdapter.mapAttachments(parsed.attachments);
      return {
        text: parsed.text,
        userId: parsed.from || 'unknown',
        threadId: EmailAdapter.threadKey(parsed.from, root || parsed.subject),
        attachments: attachments.length ? attachments : undefined,
        metadata: {
          subject: parsed.subject,
          from: parsed.from,
          to: parsed.to,
          messageId: parsed.messageId,
          references: parsed.references,
          // Full per-part detail (size, contentId, disposition) beyond
          // the normalized {url,type,name} triple.
          attachments: parsed.attachments,
          source: 'email',
        },
      };
    }

    const payload = unwrapped && typeof unwrapped === 'object' ? unwrapped : {};
    const text =
      payload.text ||
      (typeof payload.html === 'string' && payload.html ? htmlToText(payload.html) : '') ||
      payload.body ||
      '';
    const from = payload.from || payload.sender;
    const fromString =
      typeof from === 'string' ? from : EmailAdapter.extractAddress(from) || undefined;
    const to = Array.isArray(payload.to) ? payload.to.join(', ') : payload.to;
    const messageId =
      payload.messageId ||
      payload.message_id ||
      EmailAdapter.headerOf(payload.headers, 'message-id');
    const inReplyTo =
      payload.inReplyTo ||
      payload.in_reply_to ||
      EmailAdapter.headerOf(payload.headers, 'in-reply-to');
    const references =
      (typeof payload.references === 'string' ? payload.references : undefined) ||
      EmailAdapter.headerOf(payload.headers, 'references');
    const root = EmailAdapter.referencesRoot(references) || inReplyTo || messageId;
    return {
      text,
      userId: fromString || 'unknown',
      threadId: EmailAdapter.threadKey(from, root || payload.subject),
      metadata: {
        subject: payload.subject,
        from: fromString,
        to,
        messageId,
        references,
        source: 'email',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { html: response.text, text: response.text };
  }

  /**
   * Resend webhooks are svix-signed. Verification is opt-in per
   * gateway: set `configuration.resend_inbound_signing_secret` (the
   * `whsec_...` value from the Resend webhook settings) and every
   * delivery to this gateway's unified endpoint must carry a valid
   * signature over the raw body. Without the secret the adapter keeps
   * the historical accept-all behavior (raw-MIME forwarders and
   * unsigned providers).
   */
  async verifyWebhook(
    payload: any,
    headers: Record<string, string>,
    config: Record<string, any>,
    rawBody?: string,
  ): Promise<boolean> {
    const secret = config?.resend_inbound_signing_secret;
    if (!secret) return true;
    const body =
      rawBody ?? (typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}));
    return verifySvixSignature(body, headers || {}, secret);
  }

  /**
   * Reply via Resend. Threading: `In-Reply-To`/`References` are built
   * from the inbound Message-ID so mail clients file the reply into
   * the same thread, and `Reply-To` points at the gateway's inbound
   * address so the user's next reply comes back to the agent.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      if (!config.resend_api_key) {
        this.logger.warn('Email: resend_api_key not configured, cannot send reply');
        return;
      }
      const to = threadContext?.from || threadContext?.userId;
      if (!to) {
        this.logger.warn('Email: no recipient available, cannot send reply');
        return;
      }

      const meta = threadContext?.metadata || {};
      const inboundMessageId = meta.messageId || threadContext?.messageId;
      const inboundReferences = meta.references || threadContext?.references;
      const headers: Record<string, string> = {};
      if (inboundMessageId) {
        headers['In-Reply-To'] = inboundMessageId;
        // RFC 5322: the reply's References = the inbound References
        // chain plus the inbound Message-ID.
        headers['References'] = inboundReferences
          ? `${String(inboundReferences).trim()} ${inboundMessageId}`
          : inboundMessageId;
      }

      const rawSubject = (threadContext?.subject || 'Agent Response').trim();
      const subject = /^re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;

      const payload: Record<string, any> = {
        from: config.reply_from || config.inbound_address || 'agent@almyty.com',
        to,
        subject,
        html: formattedResponse.html,
      };
      if (config.inbound_address) payload.reply_to = config.inbound_address;
      if (Object.keys(headers).length > 0) payload.headers = headers;

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.resend_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      this.logger.error(`Email send failed: ${error.message}`);
    }
  }
}