import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { htmlToText, looksLikeMime, parseMimeMessage } from './mime.helper';

@Injectable()
export class EmailAdapter extends BaseAdapter {
  private readonly logger = new Logger(EmailAdapter.name);
  readonly type = 'email';

  /**
   * Accepts two inbound shapes:
   *  1. A raw MIME message — either the whole payload as a string, or a
   *     `raw` / `mime` / `email` string field (SES SNS, Mailgun "raw",
   *     CloudMailin raw mode, etc.). Parsed in-tree (see mime.helper.ts):
   *     multipart, base64/quoted-printable, encoded-word headers, and
   *     HTML-to-text stripping are handled.
   *  2. Pre-parsed JSON from an inbound-email webhook provider
   *     (SendGrid/Postmark/Resend style: text/html/body, from, subject,
   *     messageId). HTML-only payloads are stripped to text.
   */
  normalizeInbound(rawPayload: any): NormalizedMessage {
    const rawMime =
      typeof rawPayload === 'string' ? rawPayload
      : typeof rawPayload?.raw === 'string' ? rawPayload.raw
      : typeof rawPayload?.mime === 'string' ? rawPayload.mime
      : typeof rawPayload?.email === 'string' ? rawPayload.email
      : null;

    if (rawMime && looksLikeMime(rawMime)) {
      const parsed = parseMimeMessage(rawMime);
      return {
        text: parsed.text,
        userId: parsed.from || 'unknown',
        // In-Reply-To keeps a reply in the same conversation as the
        // message that started it; fall back to this message's own id.
        threadId: parsed.inReplyTo || parsed.messageId || parsed.subject,
        metadata: {
          subject: parsed.subject,
          from: parsed.from,
          to: parsed.to,
          messageId: parsed.messageId,
          source: 'email',
        },
      };
    }

    const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
    const text =
      payload.text ||
      (typeof payload.html === 'string' && payload.html ? htmlToText(payload.html) : '') ||
      payload.body ||
      '';
    return {
      text,
      userId: payload.from || payload.sender || 'unknown',
      threadId: payload.messageId || payload.subject,
      metadata: { subject: payload.subject, from: payload.from, to: payload.to, source: 'email' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { html: response.text, text: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    // Send via Resend or configured email provider
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
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.resend_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.reply_from || 'agent@almyty.com',
          to,
          subject: `Re: ${threadContext?.subject || 'Agent Response'}`,
          html: formattedResponse.html,
        }),
      });
    } catch (error) {
      this.logger.error(`Email send failed: ${error.message}`);
    }
  }
}