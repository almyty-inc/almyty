import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import { isImage, textWithMedia } from '../reply-media';
import * as crypto from 'crypto';

@Injectable()
export class GoogleChatAdapter extends BaseAdapter {
  private readonly logger = new Logger(GoogleChatAdapter.name);
  readonly type = 'google_chat';

  /** Images one reply shows. */
  static readonly MAX_IMAGES = 5;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const message = rawPayload.message || rawPayload;
    const space = rawPayload.space || message.space;
    // Files sent to the app are named, not read: Chat serves their bytes
    // only through its media API, which needs a service account or a
    // user's authorization, and this channel holds a webhook and a token.
    const attachments = (Array.isArray(message.attachment) ? message.attachment : [])
      .filter((a: any) => a && (a.contentName || a.name))
      .map((a: any) => ({ type: a.contentType || 'application/octet-stream', name: a.contentName || 'attachment' }));
    const senderId = message.sender?.name;
    return {
      text: message.text || message.argumentText || '',
      userId: message.sender?.name || message.sender?.displayName || 'unknown',
      threadId: message.thread?.name || undefined,
      ...(attachments.length ? { attachments } : {}),
      ...(senderId ? { sender: { id: senderId, name: message.sender?.displayName || undefined } } : {}),
      // A space or a group chat has several people in it; a direct message has one.
      group: GoogleChatAdapter.isGroupSpace(space),
      metadata: {
        spaceId: rawPayload.space?.name,
        spaceName: rawPayload.space?.displayName,
        messageId: message.name,
        source: 'google_chat',
      },
    };
  }

  static isGroupSpace(space: any): boolean {
    if (!space) return false;
    if (space.singleUserBotDm === true) return false;
    if (typeof space.spaceType === 'string') return space.spaceType !== 'DIRECT_MESSAGE';
    return space.type === 'ROOM';
  }

  /**
   * The message's resource name ("spaces/AAA/messages/BBB"), which
   * Google Chat repeats on a redelivery of the same event.
   */
  deliveryId(rawPayload: any): string | undefined {
    const message = rawPayload?.message ?? rawPayload;
    return message?.name ? `google_chat:${message.name}` : undefined;
  }

  /**
   * Images go as a card of image widgets under the text, which Chat
   * fetches from their links; other files stay links.
   */
  formatOutbound(response: AdapterResponse): any {
    const images = (response.attachments ?? []).filter(isImage).slice(0, GoogleChatAdapter.MAX_IMAGES);
    const text = textWithMedia(response, images);
    if (!images.length) return { text };
    return {
      text,
      cardsV2: [
        {
          cardId: 'reply-images',
          card: { sections: [{ widgets: images.map((image) => ({ image: { imageUrl: image.url, altText: image.name } })) }] },
        },
      ],
    };
  }

  /**
   * Post the reply to the space's incoming webhook.
   *
   * Google Chat's REST surface is HTTP-shaped: 200 with the created
   * Message resource on success, and a 4xx carrying
   * `{error: {code, message, status}}` on failure — 404
   * `NOT_FOUND` for a deleted space, 400 `INVALID_ARGUMENT` for a
   * thread name from another space, 403 once the webhook is revoked. So
   * the status is the verdict and `error.message`/`error.status` are
   * the wording to keep.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const webhookUrl = config.webhook_url;
    if (!webhookUrl) {
      this.sendFailed('webhook_url is not configured, so there is nowhere to send the reply');
    }

    const body: any = { text: formattedResponse.text };
    if (Array.isArray(formattedResponse.cardsV2)) body.cardsV2 = formattedResponse.cardsV2;
    if (threadContext?.threadId) {
      body.thread = { name: threadContext.threadId };
    }

    this.assertEgress(webhookUrl);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(webhookUrl, this.egressInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    const answer = await this.readJsonBody(res);
    const error = answer?.error;
    if (this.httpRejected(res) || error) {
      const detail = error?.message ?? `HTTP ${this.httpStatus(res)}`;
      this.sendFailed(
        `the space webhook refused the reply: ${detail}${error?.status ? ` (${error.status})` : ''}`,
      );
    }
  }

  /**
   * Google Chat inbound, authenticated by the shared verification token
   * the space is configured with.
   *
   * Fails closed: without the token there is nothing to distinguish
   * Google Chat from any other caller.
   *
   * Constant-time, and prefix-anchored. It was `token === config...`
   * after a `.replace('Bearer ', '')` — a non-anchored replace that
   * rewrites the first occurrence anywhere in the header, and an
   * equality that leaks its match length to an unauthenticated caller
   * with unlimited attempts. Every other secret comparison in this
   * directory (signal, matrix, irc, slack, twilio, svix) is a
   * length-guarded timingSafeEqual; this one now matches.
   *
   * Worth recording what this is NOT: Google signs inbound requests
   * with an RS256 JWT issued by chat@system.gserviceaccount.com, which
   * microsoft-teams.adapter.ts verifies properly for its own platform.
   * A static shared secret is materially weaker — it never expires and
   * it is symmetric — and moving to the JWT is a separate change.
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    if (!config.verification_token) return false;

    const header = headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length).trim();
    if (!token) return false;

    const a = Buffer.from(token);
    const b = Buffer.from(String(config.verification_token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
