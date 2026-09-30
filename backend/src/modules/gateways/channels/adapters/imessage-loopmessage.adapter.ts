import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { sharedSecretMatches } from './shared-secret.helper';

/**
 * iMessage through LoopMessage, a relay that owns the Apple-side sender.
 *
 * Configuration (a `channel-imessage-loopmessage` credential):
 *   - api_key        the organization API key, sent as the bare
 *                    `Authorization` header value (no Bearer prefix)
 *   - sender_name    optional: the sender name replies go out from, for
 *                    an organization with more than one
 *   - inbound_token  the Authorization header value set for webhooks in
 *                    the LoopMessage dashboard; every delivery carries it
 *
 * Inbound: every event goes to the one webhook URL, told apart by
 * `event`. Only `message_inbound` with text, one to one, is answered;
 * a status event (`message_sent`, `message_delivered`, ...), a reaction
 * or a group message is acknowledged and left alone. The sender is
 * `contact` (E.164 or an Apple ID email) and is the conversation key.
 *
 * Outbound: POST https://a.loopmessage.com/api/v1/message/send/ with
 * `{ contact, text, sender? }`.
 *
 * Docs:
 *   https://loopmessage.com/apidocs/send-message
 *   https://loopmessage.com/apidocs/conversation-api-webhooks
 *   https://loopmessage.com/apidocs/credentials
 */
@Injectable()
export class IMessageLoopMessageAdapter extends BaseAdapter {
  private readonly logger = new Logger(IMessageLoopMessageAdapter.name);
  readonly type = 'imessage_loopmessage';

  static readonly SEND_URL = 'https://a.loopmessage.com/api/v1/message/send/';
  /** LoopMessage takes "less than 10000 characters" per message. */
  static readonly MAX_TEXT_CHARS = 9_999;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const contact = rawPayload?.contact;
    return {
      text: typeof rawPayload?.text === 'string' ? rawPayload.text : '',
      userId: contact || 'unknown',
      threadId: contact, // the sender's number or Apple ID is the conversation key
      metadata: {
        from: contact,
        messageId: rawPayload?.message_id,
        channel: rawPayload?.channel,
        source: 'imessage_loopmessage',
      },
    };
  }

  /** An inbound text someone sent one to one; every other event is not a message to answer. */
  carriesMessage(rawPayload: any): boolean {
    if (!rawPayload || typeof rawPayload !== 'object') return false;
    if (rawPayload.event !== 'message_inbound') return false;
    if (rawPayload.group) return false;
    if (!rawPayload.contact) return false;
    return typeof rawPayload.text === 'string' && rawPayload.text.trim().length > 0;
  }

  /** The message id, the same on each of LoopMessage's retries of one delivery. */
  deliveryId(rawPayload: any): string | undefined {
    const id = rawPayload?.message_id;
    return id ? `imessage_loopmessage:${id}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text };
  }

  /**
   * LoopMessage answers 200 with `{message_id, contact, text}` on
   * success, and 400/402 (or any other error) with
   * `{success: false, code?, message}`. So `success: false` is a refusal
   * whatever the status says.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const to = threadContext?.from || threadContext?.threadId;
    if (!config.api_key) this.sendFailed('api_key is not configured, so the reply could not be sent');
    if (!to) this.sendFailed('the inbound message carried no sender to reply to');

    let text: string = formattedResponse?.text ?? '';
    if (text.length > IMessageLoopMessageAdapter.MAX_TEXT_CHARS) {
      this.logger.warn(
        `iMessage reply ${text.length} chars exceeds LoopMessage's ${IMessageLoopMessageAdapter.MAX_TEXT_CHARS}, truncating`,
      );
      text = text.slice(0, IMessageLoopMessageAdapter.MAX_TEXT_CHARS);
    }

    const payload: Record<string, string> = { contact: to, text };
    if (config.sender_name) payload.sender = String(config.sender_name);

    const url = this.assertEgress(IMessageLoopMessageAdapter.SEND_URL);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(url, this.egressInit({
      method: 'POST',
      headers: {
        'Authorization': String(config.api_key),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }));

    const body = await this.readJsonBody(res);
    if (this.httpRejected(res) || body?.success === false) {
      const detail = body?.message ?? `HTTP ${this.httpStatus(res)}`;
      const code = body?.code !== undefined ? ` (code ${body.code})` : '';
      this.sendFailed(`LoopMessage refused the reply: ${detail}${code}`);
    }
  }

  /**
   * LoopMessage does not sign deliveries; it sends the Authorization
   * header value configured for webhooks in its dashboard. That is
   * compared in constant time against `inbound_token`, as given or with
   * a `Bearer ` prefix, whichever way it was typed there.
   *
   * Fails closed: with no token configured nothing is accepted.
   */
  async verifyWebhook(_payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    const expected = config?.inbound_token;
    const presented = headers?.['authorization'];
    if (sharedSecretMatches(presented, expected)) return true;
    const bearer = typeof presented === 'string' && presented.startsWith('Bearer ') ? presented.slice(7).trim() : undefined;
    return sharedSecretMatches(bearer, expected);
  }
}
