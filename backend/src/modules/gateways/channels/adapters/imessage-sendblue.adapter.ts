import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { sharedSecretMatches } from './shared-secret.helper';
import { attachmentFromUrl, outboundMediaUrls, sentAttachments } from './relay-media.helper';
import { textWithMedia } from '../reply-media';

/**
 * iMessage through Sendblue, a relay that owns the Apple-side number.
 *
 * Configuration (a `channel-imessage-sendblue` credential):
 *   - api_key_id      sent as `sb-api-key-id`
 *   - api_secret_key  sent as `sb-api-secret-key`
 *   - phone_number    the Sendblue line replies go out from (E.164),
 *                     the API's `from_number`
 *   - signing_secret  the secret on the receive webhook. Publishing
 *                     registers the webhook with it (channel-webhook-
 *                     registrar.service.ts); Sendblue sends it back in
 *                     the `sb-signing-secret` header of every delivery
 *
 * Inbound (the "receive" webhook): a JSON body with `content`,
 * `from_number`, `to_number`, `message_handle`, `is_outbound`, `status`,
 * `service`, `media_url` (one CDN link, empty when nothing is attached)
 * and, for a group chat, `group_id`, `participants` and
 * `group_display_name`. An outbound echo or a status callback is
 * acknowledged and left alone. A group message is answered in the group:
 * the group is the conversation, the member who wrote is the sender.
 *
 * Outbound: POST https://api.sendblue.co/api/send-message with
 * `{ number, from_number, content, media_url? }`, or, in a group,
 * POST https://api.sendblue.co/api/send-group-message with
 * `{ group_id, from_number, content, media_url? }`. `media_url` takes one
 * link per message, so a reply with several files sends the rest as
 * messages of their own.
 *
 * Docs:
 *   https://docs.sendblue.com/api/resources/messages/methods/send/
 *   https://docs.sendblue.com/api/resources/groups/methods/send_message/
 *   https://docs.sendblue.com/getting-started/receiving-messages/ (media_url, group fields)
 *   https://docs.sendblue.com/getting-started/groups/
 *   https://docs.sendblue.com/getting-started/webhooks/
 *   https://docs.sendblue.com/guides/chat-sdk-adapter/ (sb-signing-secret)
 */
@Injectable()
export class IMessageSendblueAdapter extends BaseAdapter {
  private readonly logger = new Logger(IMessageSendblueAdapter.name);
  readonly type = 'imessage_sendblue';

  static readonly SEND_URL = 'https://api.sendblue.co/api/send-message';
  static readonly SEND_GROUP_URL = 'https://api.sendblue.co/api/send-group-message';
  /** Sendblue's documented ceiling for `content`. */
  static readonly MAX_CONTENT_CHARS = 18_996;
  /** Files one reply sends at most; each past the first is a message of its own. */
  static readonly MAX_MEDIA = 5;
  /** The header Sendblue carries the configured webhook secret in. */
  static readonly SECRET_HEADER = 'sb-signing-secret';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const from = rawPayload?.from_number;
    const groupId = IMessageSendblueAdapter.groupIdOf(rawPayload);
    const media = attachmentFromUrl(rawPayload?.media_url);
    return {
      text: typeof rawPayload?.content === 'string' ? rawPayload.content : '',
      // The member who wrote, in a group too: their share of the visitor
      // limits is theirs, not the group's.
      userId: from || 'unknown',
      // The conversation: the group when there is one, else the sender.
      threadId: groupId ?? from,
      ...(media ? { attachments: [media] } : {}),
      // In a group each message is read as its writer's; the relay names
      // them only by number, so they read as a short id (channel-speaker.ts).
      ...(from ? { sender: { id: from } } : {}),
      group: !!groupId,
      metadata: {
        from,
        to: rawPayload?.to_number,
        messageHandle: rawPayload?.message_handle,
        service: rawPayload?.service,
        ...(groupId
          ? {
              groupId,
              groupName: typeof rawPayload?.group_display_name === 'string' ? rawPayload.group_display_name : undefined,
            }
          : {}),
        source: 'imessage_sendblue',
      },
    };
  }

  /** `group_id` is present and empty on a one-to-one message. */
  private static groupIdOf(rawPayload: any): string | undefined {
    const id = rawPayload?.group_id;
    return typeof id === 'string' && id.trim() ? id.trim() : undefined;
  }

  /**
   * A message someone sent to the line, one to one or in a group, with
   * text or a file. Sendblue posts outbound events and status changes to
   * webhooks too, and answering our own echo would have the agent talk to
   * itself.
   */
  carriesMessage(rawPayload: any): boolean {
    if (!rawPayload || typeof rawPayload !== 'object') return false;
    if (rawPayload.is_outbound === true) return false;
    if (!rawPayload.from_number) return false;
    const text = typeof rawPayload.content === 'string' && rawPayload.content.trim().length > 0;
    return text || attachmentFromUrl(rawPayload.media_url) !== null;
  }

  /** Sendblue's message handle, the documented dedupe key across its retries. */
  deliveryId(rawPayload: any): string | undefined {
    const handle = rawPayload?.message_handle;
    return handle ? `imessage_sendblue:${handle}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    const media = outboundMediaUrls(response.attachments, IMessageSendblueAdapter.MAX_MEDIA);
    const content = textWithMedia(response, sentAttachments(response.attachments, media));
    return media.length ? { content, media } : { content };
  }

  /**
   * Sendblue answers 200 with a message document whose `status` is
   * QUEUED, SENT, DELIVERED or ERROR; a refusal carries `error_code` /
   * `error_key` / `error_message`. So a 2xx is not enough on its own: an
   * ERROR status or an error key is a refusal too.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const groupId: string | undefined = threadContext?.groupId || undefined;
    const to = threadContext?.from || threadContext?.threadId;
    if (!config.api_key_id || !config.api_secret_key) {
      this.sendFailed('api_key_id and api_secret_key are not configured, so the reply could not be sent');
    }
    if (!config.phone_number) this.sendFailed('phone_number is not configured, so the reply could not be sent');
    if (!groupId && !to) this.sendFailed('the inbound message carried no sender to reply to');

    let content: string = formattedResponse?.content ?? '';
    if (content.length > IMessageSendblueAdapter.MAX_CONTENT_CHARS) {
      this.logger.warn(
        `iMessage reply ${content.length} chars exceeds Sendblue's ${IMessageSendblueAdapter.MAX_CONTENT_CHARS}, truncating`,
      );
      content = content.slice(0, IMessageSendblueAdapter.MAX_CONTENT_CHARS);
    }
    const media: string[] = Array.isArray(formattedResponse?.media) ? formattedResponse.media : [];

    // The reply goes back where it came from: the group, or the sender.
    const url = groupId ? IMessageSendblueAdapter.SEND_GROUP_URL : IMessageSendblueAdapter.SEND_URL;
    const address = groupId ? { group_id: groupId } : { number: to };

    const messages: Array<Record<string, string>> = [
      { ...address, from_number: config.phone_number, content, ...(media[0] ? { media_url: media[0] } : {}) },
      ...media.slice(1).map((media_url) => ({ ...address, from_number: config.phone_number, media_url })),
    ];
    for (const message of messages) await this.send(config, url, message);
  }

  private async send(config: Record<string, any>, target: string, message: Record<string, string>): Promise<void> {
    const url = this.assertEgress(target);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(url, this.egressInit({
      method: 'POST',
      headers: {
        'sb-api-key-id': String(config.api_key_id),
        'sb-api-secret-key': String(config.api_secret_key),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
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
