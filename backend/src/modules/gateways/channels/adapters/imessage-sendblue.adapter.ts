import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { sharedSecretMatches } from './shared-secret.helper';

/**
 * iMessage through Sendblue, a relay that owns the Apple-side number.
 *
 * Configuration (a `channel-imessage-sendblue` credential):
 *   - api_key_id      sent as `sb-api-key-id`
 *   - api_secret_key  sent as `sb-api-secret-key`
 *   - phone_number    the Sendblue line replies go out from (E.164),
 *                     the API's `from_number`
 *   - signing_secret  the secret set on the receive webhook in Sendblue
 *                     (Developer -> Webhooks); Sendblue sends it back in
 *                     the `sb-signing-secret` header of every delivery
 *
 * Inbound (the "receive" webhook): a JSON body with `content`,
 * `from_number`, `to_number`, `message_handle`, `is_outbound`, `status`,
 * `service` and, for a group chat, `group_id`. Only 1:1 inbound text is
 * answered: an outbound echo, a status callback or a group message is
 * acknowledged and left alone.
 *
 * Outbound: POST https://api.sendblue.co/api/send-message with
 * `{ number, from_number, content }`.
 *
 * Docs:
 *   https://docs.sendblue.com/api/resources/messages/methods/send/
 *   https://docs.sendblue.com/getting-started/webhooks/
 *   https://docs.sendblue.com/guides/chat-sdk-adapter/ (sb-signing-secret)
 */
@Injectable()
export class IMessageSendblueAdapter extends BaseAdapter {
  private readonly logger = new Logger(IMessageSendblueAdapter.name);
  readonly type = 'imessage_sendblue';

  static readonly SEND_URL = 'https://api.sendblue.co/api/send-message';
  /** Sendblue's documented ceiling for `content`. */
  static readonly MAX_CONTENT_CHARS = 18_996;
  /** The header Sendblue carries the configured webhook secret in. */
  static readonly SECRET_HEADER = 'sb-signing-secret';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const from = rawPayload?.from_number;
    return {
      text: typeof rawPayload?.content === 'string' ? rawPayload.content : '',
      userId: from || 'unknown',
      threadId: from, // the sender's number is the conversation key
      metadata: {
        from,
        to: rawPayload?.to_number,
        messageHandle: rawPayload?.message_handle,
        service: rawPayload?.service,
        source: 'imessage_sendblue',
      },
    };
  }

  /**
   * A message someone sent to the line, one to one. Sendblue posts
   * outbound events and status changes to webhooks too, and answering
   * our own echo would have the agent talk to itself.
   */
  carriesMessage(rawPayload: any): boolean {
    if (!rawPayload || typeof rawPayload !== 'object') return false;
    if (rawPayload.is_outbound === true) return false;
    if (rawPayload.group_id) return false;
    if (!rawPayload.from_number) return false;
    return typeof rawPayload.content === 'string' && rawPayload.content.trim().length > 0;
  }

  /** Sendblue's message handle, the documented dedupe key across its retries. */
  deliveryId(rawPayload: any): string | undefined {
    const handle = rawPayload?.message_handle;
    return handle ? `imessage_sendblue:${handle}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return { content: response.text };
  }

  /**
   * Sendblue answers 200 with a message document whose `status` is
   * QUEUED, SENT, DELIVERED or ERROR; a refusal carries `error_code` /
   * `error_key` / `error_message`. So a 2xx is not enough on its own: an
   * ERROR status or an error key is a refusal too.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const to = threadContext?.from || threadContext?.threadId;
    if (!config.api_key_id || !config.api_secret_key) {
      this.sendFailed('api_key_id and api_secret_key are not configured, so the reply could not be sent');
    }
    if (!config.phone_number) this.sendFailed('phone_number is not configured, so the reply could not be sent');
    if (!to) this.sendFailed('the inbound message carried no sender to reply to');

    let content: string = formattedResponse?.content ?? '';
    if (content.length > IMessageSendblueAdapter.MAX_CONTENT_CHARS) {
      this.logger.warn(
        `iMessage reply ${content.length} chars exceeds Sendblue's ${IMessageSendblueAdapter.MAX_CONTENT_CHARS}, truncating`,
      );
      content = content.slice(0, IMessageSendblueAdapter.MAX_CONTENT_CHARS);
    }

    const url = this.assertEgress(IMessageSendblueAdapter.SEND_URL);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(url, this.egressInit({
      method: 'POST',
      headers: {
        'sb-api-key-id': String(config.api_key_id),
        'sb-api-secret-key': String(config.api_secret_key),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ number: to, from_number: config.phone_number, content }),
    }));

    const body = await this.readJsonBody(res);
    const status = typeof body?.status === 'string' ? body.status.toUpperCase() : undefined;
    const errorKey = body?.error_key ?? body?.error_code;
    if (this.httpRejected(res) || status === 'ERROR' || errorKey) {
      const detail = body?.error_message ?? body?.message ?? `HTTP ${this.httpStatus(res)}`;
      const key = errorKey ? ` (${errorKey})` : '';
      this.sendFailed(`Sendblue refused the reply: ${detail}${key}`);
    }
  }

  /**
   * Sendblue does not sign deliveries; it sends back the secret set on
   * the webhook in `sb-signing-secret`, compared here in constant time
   * against `signing_secret`.
   *
   * Fails closed: with no secret configured nothing is accepted, since
   * anyone who learned the callback URL could otherwise start runs as
   * any sender.
   */
  async verifyWebhook(_payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    return sharedSecretMatches(headers?.[IMessageSendblueAdapter.SECRET_HEADER], config?.signing_secret);
  }
}
