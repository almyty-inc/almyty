import { Injectable, Logger } from '@nestjs/common';
import {
  BaseAdapter,
  NormalizedMessage,
  AdapterResponse,
  AttachmentFetchLimits,
  FetchedAttachment,
  InboundAttachment,
  OutboundAttachment,
} from './base.adapter';
import { verifyTwilioSignature } from './twilio-signature.helper';
import { twilioSendFailure } from './twilio-response.helper';
import { TWILIO_MEDIA_HOSTS, twilioAuthHeader, twilioInboundMedia } from './twilio-media.helper';
import { textWithMedia } from '../reply-media';

@Injectable()
export class WhatsAppAdapter extends BaseAdapter {
  private readonly logger = new Logger(WhatsAppAdapter.name);
  readonly type = 'whatsapp';

  /** The most media one reply sends; WhatsApp takes one per message. */
  static readonly MAX_MEDIA = 5;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Twilio WhatsApp format
    const attachments = twilioInboundMedia(rawPayload);
    return {
      text: rawPayload.Body || '',
      userId: rawPayload.From || 'unknown',
      threadId: rawPayload.From, // Use phone number as thread
      ...(attachments.length ? { attachments } : {}),
      metadata: { from: rawPayload.From, to: rawPayload.To, messageSid: rawPayload.MessageSid, source: 'whatsapp' },
    };
  }

  /** Twilio media, read with the account's credentials on Twilio's own host only. */
  async fetchAttachment(
    attachment: InboundAttachment,
    config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    const auth = twilioAuthHeader(config);
    if (!auth || !BaseAdapter.onHost(attachment.url, TWILIO_MEDIA_HOSTS)) return null;
    return this.fetchBytes(attachment.url!, limits, { Authorization: auth });
  }

  /** Twilio's MessageSid, unchanged across Twilio's own retries. */
  deliveryId(rawPayload: any): string | undefined {
    return rawPayload?.MessageSid ? `whatsapp:${rawPayload.MessageSid}` : undefined;
  }

  /**
   * Images and PDFs go as WhatsApp media (MediaUrl), which Twilio fetches
   * from the link; one per message, the first with the text. Anything else
   * stays a link.
   */
  formatOutbound(response: AdapterResponse): any {
    const sent: OutboundAttachment[] = (response.attachments ?? [])
      .filter((a) => /^image\/(png|jpeg)$/.test(a.type) || a.type === 'application/pdf')
      .slice(0, WhatsAppAdapter.MAX_MEDIA);
    const body = textWithMedia(response, sent);
    return sent.length ? { body, media: sent.map((a) => a.url) } : { body };
  }

  /**
   * Reply through the Twilio Messages API. See twilio-response.helper.ts
   * for the success contract; the `whatsapp:` address prefix is the only
   * thing that differs from the sms adapter.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    // threadId carries the sender's whatsapp:+E164 address (it is the
    // conversation key), so it doubles as the reply-to when the caller
    // didn't pass `from` explicitly.
    const to = threadContext?.from || threadContext?.threadId;
    const media: string[] = Array.isArray(formattedResponse.media) ? formattedResponse.media : [];
    await this.send(config, to, formattedResponse.body, media[0]);
    for (const url of media.slice(1)) await this.send(config, to, '', url);
  }

  private async send(config: Record<string, any>, to: string, text: string, mediaUrl?: string): Promise<void> {
    const accountSid = config.twilio_account_sid;
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const params = new URLSearchParams({ From: `whatsapp:${config.phone_number}`, To: to, Body: text ?? '' });
    if (mediaUrl) params.append('MediaUrl', mediaUrl);

    const res = await (fetch as any)(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': twilioAuthHeader(config) ?? '',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
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