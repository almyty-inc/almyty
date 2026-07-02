import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

/**
 * WhatsApp via Meta's Cloud API (direct, no Twilio in between).
 *
 * Configuration:
 *   - access_token     Meta system-user / app token used for outbound
 *   - phone_number_id  the Cloud API phone number id (not the E.164)
 *   - verify_token     shared secret echoed during Meta's GET webhook
 *                      verification handshake (hub.challenge)
 *   - app_secret       app secret used to verify X-Hub-Signature-256
 *                      on inbound POSTs (HMAC-SHA256 over the raw body)
 *
 * Inbound shape (POST): entry[].changes[].value.messages[] — text
 * messages carry text.body; `from` is the sender's E.164 (no prefix)
 * and doubles as the conversation thread key.
 *
 * Outbound: POST graph.facebook.com/<ver>/<phone_number_id>/messages
 * with { messaging_product: "whatsapp", to, text: { body } }.
 *
 * The GET verification handshake (hub.mode=subscribe) is handled in
 * the unified delegation layer, which calls handleVerification().
 */
@Injectable()
export class WhatsAppCloudAdapter extends BaseAdapter {
  private readonly logger = new Logger(WhatsAppCloudAdapter.name);
  readonly type = 'whatsapp_cloud';

  static readonly GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const value = rawPayload?.entry?.[0]?.changes?.[0]?.value ?? {};
    const message = value?.messages?.[0] ?? {};
    const contact = value?.contacts?.[0];
    return {
      text: message?.text?.body || '',
      userId: message?.from || 'unknown',
      threadId: message?.from, // sender E.164 is the conversation key
      metadata: {
        from: message?.from,
        messageId: message?.id,
        phoneNumberId: value?.metadata?.phone_number_id,
        profileName: contact?.profile?.name,
        source: 'whatsapp_cloud',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { body: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const to = threadContext?.from || threadContext?.threadId;
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)(
        `${WhatsAppCloudAdapter.GRAPH_API_BASE}/${config.phone_number_id}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            text: { body: formattedResponse.body },
          }),
        },
      );
    } catch (error) {
      this.logger.error(`WhatsApp Cloud send failed: ${error.message}`);
    }
  }

  /**
   * Meta signs every webhook POST with X-Hub-Signature-256:
   * `sha256=` + hex(HMAC-SHA256(app_secret, raw body bytes)).
   * Enforced when app_secret is configured; skipped otherwise
   * (mirroring the Slack adapter's optional signing_secret).
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
    const appSecret = config.app_secret;
    if (!appSecret) return true;

    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;

    const raw = rawBody ?? JSON.stringify(payload ?? {});
    const expected =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(raw, 'utf-8').digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Meta webhook verification handshake (GET with hub.* query params):
   * echo hub.challenge iff hub.mode is "subscribe" and hub.verify_token
   * matches the configured verify_token. Returns the challenge string
   * to echo, or null when verification fails.
   */
  static handleVerification(
    query: Record<string, any>,
    config: Record<string, any>,
  ): string | null {
    const mode = query?.['hub.mode'];
    const token = query?.['hub.verify_token'];
    const challenge = query?.['hub.challenge'];
    if (mode !== 'subscribe') return null;
    if (!config?.verify_token || token !== config.verify_token) return null;
    return String(challenge ?? '');
  }
}
