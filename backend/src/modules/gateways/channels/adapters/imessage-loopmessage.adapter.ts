import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { sharedSecretMatches } from './shared-secret.helper';
import { attachmentFromUrl, outboundMediaUrls, type ChannelAttachment } from './relay-media.helper';

/**
 * iMessage through LoopMessage, a relay that owns the Apple-side sender.
 *
 * Configuration:
 *   - api_key        (the `channel-imessage-loopmessage` credential) the
 *                    organization API key, sent as the bare
 *                    `Authorization` header value (no Bearer prefix)
 *   - inbound_token  (the credential) the Authorization header value set
 *                    for webhooks in the LoopMessage dashboard; every
 *                    delivery carries it
 *   - sender_name    (the channel page) the sender name replies go out
 *                    from. Required: publishing refuses a channel
 *                    without one (channel-rules.ts SENDER_NAME_REQUIRED)
 *
 * Inbound: every event goes to the one webhook URL, told apart by
 * `event`. Only `message_inbound` with text or attachments is answered;
 * a status event (`message_sent`, `message_delivered`, ...) or a reaction
 * is acknowledged and left alone. The sender is `contact` (E.164 or an
 * Apple ID email). One to one the sender is the conversation; in a group
 * (`group: { id, name?, participants }`) the group is, and the reply goes
 * to the group. `attachments` is an array of download URLs.
 *
 * Outbound: POST https://a.loopmessage.com/api/v1/message/send/ with
 * `{ contact | group, text, sender, attachments? }`; `attachments` takes
 * up to ten https URLs of at most 256 characters each.
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
  readonly fetchesInboundAttachments = true;

  static readonly SEND_URL = 'https://a.loopmessage.com/api/v1/message/send/';
  /** LoopMessage takes "less than 10000 characters" per message. */
  static readonly MAX_TEXT_CHARS = 9_999;
  /** LoopMessage's documented ceilings on `attachments`. */
  static readonly MAX_ATTACHMENTS = 10;
  static readonly MAX_ATTACHMENT_URL_CHARS = 256;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const contact = rawPayload?.contact;
    const groupId = IMessageLoopMessageAdapter.groupIdOf(rawPayload);
    const attachments = (Array.isArray(rawPayload?.attachments) ? rawPayload.attachments : [])
      .map(attachmentFromUrl)
      .filter((a: ChannelAttachment | null): a is ChannelAttachment => a !== null);
    return {
      text: typeof rawPayload?.text === 'string' ? rawPayload.text : '',
      // The member who wrote, in a group too: their share of the visitor
      // limits is theirs, not the group's.
      userId: contact || 'unknown',
      // The conversation: the group when there is one, else the sender.
      threadId: groupId ?? contact,
      ...(attachments.length ? { attachments } : {}),
      metadata: {
        from: contact,
        messageId: rawPayload?.message_id,
        channel: rawPayload?.channel,
        ...(groupId
          ? {
              groupId,
              groupName: typeof rawPayload?.group?.name === 'string' ? rawPayload.group.name : undefined,
            }
          : {}),
        source: 'imessage_loopmessage',
      },
    };
  }

  private static groupIdOf(rawPayload: any): string | undefined {
    const id = rawPayload?.group?.id;
    return typeof id === 'string' && id.trim() ? id.trim() : undefined;
  }

  /** An inbound message with text or a file, one to one or in a group; every other event is not a message to answer. */
  carriesMessage(rawPayload: any): boolean {
    if (!rawPayload || typeof rawPayload !== 'object') return false;
    if (rawPayload.event !== 'message_inbound') return false;
    if (!rawPayload.contact) return false;
    const text = typeof rawPayload.text === 'string' && rawPayload.text.trim().length > 0;
    const files = Array.isArray(rawPayload.attachments) && rawPayload.attachments.some((a: unknown) => attachmentFromUrl(a));
    return text || files;
  }

  /** The message id, the same on each of LoopMessage's retries of one delivery. */
  deliveryId(rawPayload: any): string | undefined {
    const id = rawPayload?.message_id;
    return id ? `imessage_loopmessage:${id}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    const attachments = outboundMediaUrls(
      response.attachments,
      IMessageLoopMessageAdapter.MAX_ATTACHMENTS,
      IMessageLoopMessageAdapter.MAX_ATTACHMENT_URL_CHARS,
    );
    return attachments.length ? { text: response.text, attachments } : { text: response.text };
  }

  /**
   * LoopMessage answers 200 with `{message_id, contact, text}` on
   * success, and 400/402 (or any other error) with
   * `{success: false, code?, message}`. So `success: false` is a refusal
   * whatever the status says.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const groupId: string | undefined = threadContext?.groupId || undefined;
    const to = threadContext?.from || threadContext?.threadId;
    const sender = typeof config.sender_name === 'string' ? config.sender_name.trim() : '';
    if (!config.api_key) this.sendFailed('api_key is not configured, so the reply could not be sent');
    if (!sender) this.sendFailed('sender_name is not configured, so the reply could not be sent');
    if (!groupId && !to) this.sendFailed('the inbound message carried no sender to reply to');

    let text: string = formattedResponse?.text ?? '';
    if (text.length > IMessageLoopMessageAdapter.MAX_TEXT_CHARS) {
      this.logger.warn(
        `iMessage reply ${text.length} chars exceeds LoopMessage's ${IMessageLoopMessageAdapter.MAX_TEXT_CHARS}, truncating`,
      );
      text = text.slice(0, IMessageLoopMessageAdapter.MAX_TEXT_CHARS);
    }

    // The reply goes back where it came from: the group, or the sender.
    const payload: Record<string, unknown> = groupId ? { group: groupId, text, sender } : { contact: to, text, sender };
    if (Array.isArray(formattedResponse?.attachments) && formattedResponse.attachments.length) {
      payload.attachments = formattedResponse.attachments;
    }

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
