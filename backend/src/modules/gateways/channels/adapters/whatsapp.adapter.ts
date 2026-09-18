import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { verifyTwilioSignature } from './twilio-signature.helper';
import { twilioSendFailure } from './twilio-response.helper';

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

  /** Twilio's MessageSid, unchanged across Twilio's own retries. */
  deliveryId(rawPayload: any): string | undefined {
    return rawPayload?.MessageSid ? `whatsapp:${rawPayload.MessageSid}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return { body: response.text };
  }

  /**
   * Reply through the Twilio Messages API. See twilio-response.helper.ts
   * for the success contract; the `whatsapp:` address prefix is the only
   * thing that differs from the sms adapter.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const accountSid = config.twilio_account_sid;
    const authToken = config.twilio_auth_token;
    const from = config.phone_number;
    // threadId carries the sender's whatsapp:+E164 address (it is the
    // conversation key), so it doubles as the reply-to when the caller
    // didn't pass `from` explicitly.
    const to = threadContext?.from || threadContext?.threadId;

    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const res = await (fetch as any)(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
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

    const rejected = this.httpRejected(res);
    const body = await this.readJsonBody(res);
    const failure = twilioSendFailure(res?.status, rejected, body);
    if (failure) this.sendFailed(failure);
  }

  /**
   * Twilio X-Twilio-Signature validation — shared with the sms adapter
   * (both are Twilio form-encoded webhooks). See
   * twilio-signature.helper.ts for the algorithm and skip semantics.
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    return verifyTwilioSignature(payload, headers, config);
  }
}