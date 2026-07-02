import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

@Injectable()
export class WhatsAppAdapter extends BaseAdapter {
  private readonly logger = new Logger(WhatsAppAdapter.name);
  readonly type = 'whatsapp';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Twilio WhatsApp format
    return {
      text: rawPayload.Body || '',
      userId: rawPayload.From || 'unknown',
      threadId: rawPayload.From, // Use phone number as thread
      metadata: { from: rawPayload.From, to: rawPayload.To, messageSid: rawPayload.MessageSid, source: 'whatsapp' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { body: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const accountSid = config.twilio_account_sid;
      const authToken = config.twilio_auth_token;
      const from = config.phone_number;
      // threadId carries the sender's whatsapp:+E164 address (it is the
      // conversation key), so it doubles as the reply-to when the caller
      // didn't pass `from` explicitly.
      const to = threadContext?.from || threadContext?.threadId;

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      await (fetch as any)(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: `whatsapp:${from}`,
          To: to,
          Body: formattedResponse.body,
        }).toString(),
      });
    } catch (error) {
      this.logger.error(`WhatsApp send failed: ${error.message}`);
    }
  }

  /**
   * Validate Twilio's X-Twilio-Signature header: base64(HMAC-SHA1(auth
   * token, exact public webhook URL + POST params sorted alphabetically
   * by key, each appended as key+value)). See
   * https://www.twilio.com/docs/usage/security#validating-requests
   *
   * Verification is enforced when both `twilio_auth_token` and
   * `webhook_url` (the exact URL configured in the Twilio console —
   * needed because Twilio signs the full URL and we sit behind a proxy)
   * are configured. Without `webhook_url` the signed URL cannot be
   * reconstructed, so the check is skipped — mirroring the Slack
   * adapter's optional `signing_secret`.
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    const authToken = config.twilio_auth_token;
    const url = config.webhook_url;
    if (!authToken || !url) return true;

    const signature = headers['x-twilio-signature'];
    if (!signature) return false;

    const params = payload && typeof payload === 'object' ? payload : {};
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + String(params[key] ?? ''), String(url));
    const expected = crypto.createHmac('sha1', authToken).update(data, 'utf-8').digest('base64');

    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}