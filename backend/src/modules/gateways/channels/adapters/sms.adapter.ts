import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { verifyTwilioSignature } from './twilio-signature.helper';
import { twilioSendFailure } from './twilio-response.helper';

/**
 * Plain SMS via Twilio. Same credential shape as the Twilio-backed
 * whatsapp adapter (twilio_account_sid, twilio_auth_token,
 * phone_number, webhook_url) but without the `whatsapp:` address
 * prefix: `From`/`To` are bare E.164 numbers.
 *
 * Inbound: Twilio posts the standard form-encoded SMS webhook
 * (Body/From/To/MessageSid), verified via X-Twilio-Signature (shared
 * helper). Outbound: Messages API. Twilio rejects bodies over 1600
 * chars (concatenated-segment API limit), so replies are truncated at
 * 1600 with a warning — an agent reply that long is billing ~23 SMS
 * segments anyway.
 */
@Injectable()
export class SmsAdapter extends BaseAdapter {
  private readonly logger = new Logger(SmsAdapter.name);
  readonly type = 'sms';

  /** Twilio Messages API hard limit for a (concatenated) message body. */
  static readonly MAX_BODY_CHARS = 1600;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Twilio SMS webhook format (form-encoded)
    return {
      text: rawPayload.Body || '',
      userId: rawPayload.From || 'unknown',
      threadId: rawPayload.From, // Use phone number as thread
      metadata: { from: rawPayload.From, to: rawPayload.To, messageSid: rawPayload.MessageSid, source: 'sms' },
    };
  }

  /** Twilio's MessageSid, unchanged across Twilio's own retries. */
  deliveryId(rawPayload: any): string | undefined {
    return rawPayload?.MessageSid ? `sms:${rawPayload.MessageSid}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return { body: response.text };
  }

  /**
   * Reply through the Twilio Messages API. See twilio-response.helper.ts
   * for the success contract.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const accountSid = config.twilio_account_sid;
    const authToken = config.twilio_auth_token;
    const from = config.phone_number;
    // threadId carries the sender's E.164 number (it is the
    // conversation key), so it doubles as the reply-to when the
    // caller didn't pass `from` explicitly.
    const to = threadContext?.from || threadContext?.threadId;

    let body: string = formattedResponse.body ?? '';
    if (body.length > SmsAdapter.MAX_BODY_CHARS) {
      this.logger.warn(
        `SMS body ${body.length} chars exceeds Twilio's ${SmsAdapter.MAX_BODY_CHARS}-char limit — truncating`,
      );
      body = body.slice(0, SmsAdapter.MAX_BODY_CHARS);
    }

    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const res = await (fetch as any)(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: from,
        To: to,
        Body: body,
      }).toString(),
    });

    const rejected = this.httpRejected(res);
    const answer = await this.readJsonBody(res);
    const failure = twilioSendFailure(res?.status, rejected, answer);
    if (failure) this.sendFailed(failure);
  }

  /**
   * Twilio X-Twilio-Signature validation — shared with the whatsapp
   * adapter. See twilio-signature.helper.ts for the algorithm and
   * skip semantics.
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    return verifyTwilioSignature(payload, headers, config);
  }
}
