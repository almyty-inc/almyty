import { Injectable, Logger } from '@nestjs/common';
import {
  BaseAdapter,
  NormalizedMessage,
  AdapterResponse,
  AttachmentFetchLimits,
  FetchedAttachment,
  InboundAttachment,
} from './base.adapter';
import * as crypto from 'crypto';

/** Message types whose `url` is a file (mxc://server/mediaId). */
const FILE_MSGTYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video']);

@Injectable()
export class MatrixAdapter extends BaseAdapter {
  private readonly logger = new Logger(MatrixAdapter.name);
  readonly type = 'matrix';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Matrix client-server API event format
    const event = rawPayload;
    const content = event.content || {};
    const isFile = FILE_MSGTYPES.has(content.msgtype);
    // An unencrypted file carries an mxc:// URI; an encrypted one (`file`)
    // cannot be read by a bridge that does not hold the room keys.
    const attachments: InboundAttachment[] =
      isFile && typeof content.url === 'string' && content.url.startsWith('mxc://')
        ? [{
            ref: content.url,
            type: content.info?.mimetype || 'application/octet-stream',
            name: content.filename || content.body || 'attachment',
            ...(typeof content.info?.size === 'number' ? { size: content.info.size } : {}),
          }]
        : [];
    // A file's body is its filename unless a separate filename makes it a caption.
    const text = isFile ? (content.filename && content.body !== content.filename ? content.body : '') : content.body || '';
    const sender = typeof event.sender === 'string' ? event.sender : undefined;
    return {
      text: text || '',
      userId: event.sender || 'unknown',
      threadId: event.room_id || undefined,
      ...(attachments.length ? { attachments } : {}),
      // "@anna:example.org" reads as "anna".
      ...(sender ? { sender: { id: sender, name: sender.replace(/^@/, '').split(':')[0] || undefined } } : {}),
      // A room is where several people can talk, and an event does not say
      // whether this one is a direct chat, so every message is named.
      group: true,
      metadata: {
        eventId: event.event_id,
        roomId: event.room_id,
        eventType: event.type,
        source: 'matrix',
      },
    };
  }

  /**
   * An mxc:// URI read from the configured homeserver's authenticated media
   * endpoint, with the access token, through the egress guard.
   */
  async fetchAttachment(
    attachment: InboundAttachment,
    config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    const match = /^mxc:\/\/([A-Za-z0-9.:\-\[\]]+)\/([A-Za-z0-9_-]+)$/.exec(attachment.ref ?? '');
    if (!match || !config.homeserver_url || !config.access_token) return null;
    const base = String(config.homeserver_url).replace(/(?<!\/)\/+$/, '');
    const url = `${base}/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
    return this.fetchBytes(url, limits, { Authorization: `Bearer ${config.access_token}` });
  }

  /** The Matrix event id, globally unique and stable on replay. */
  deliveryId(rawPayload: any): string | undefined {
    return rawPayload?.event_id ? `matrix:${rawPayload.event_id}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return {
      msgtype: 'm.text',
      body: response.text,
    };
  }

  /**
   * PUT the reply into the room.
   *
   * The client-server API is HTTP-shaped: 200 with `{event_id}` on
   * success, and a 4xx carrying `{errcode, error}` on failure —
   * `M_FORBIDDEN` when the bot is not joined to the room,
   * `M_UNKNOWN_TOKEN` on a logged-out access token, `M_LIMIT_EXCEEDED`
   * when rate limited. So the status is the verdict and
   * `errcode`/`error` are the wording to keep — the same pair
   * `testConnection` reads off whoami.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const homeserverUrl = config.homeserver_url;
    const accessToken = config.access_token;
    const roomId = threadContext?.threadId || config.room_id;

    if (!homeserverUrl || !accessToken || !roomId) {
      const missing = [
        !homeserverUrl && 'homeserver_url',
        !accessToken && 'access_token',
        !roomId && 'room_id',
      ].filter(Boolean).join(', ');
      this.sendFailed(`${missing} missing, so the reply could not be sent`);
    }

    const txnId = `m${Date.now()}`;
    const encodedRoomId = encodeURIComponent(roomId);
    const url = `${homeserverUrl}/_matrix/client/r0/rooms/${encodedRoomId}/send/m.room.message/${txnId}`;

    this.assertEgress(url);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(url, this.egressInit({
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formattedResponse),
    }));

    const body = await this.readJsonBody(res);
    if (this.httpRejected(res) || body?.errcode) {
      const detail = body?.error ?? `HTTP ${this.httpStatus(res)}`;
      this.sendFailed(
        `the homeserver refused the reply: ${detail}${body?.errcode ? ` (${body.errcode})` : ''}`,
      );
    }
  }

  /**
   * The bridge POSTs envelopes in over HTTP, so it must prove it is the
   * bridge. Same shared-secret shape the IRC bridge uses: a bearer token
   * (or X-Bridge-Token) compared in constant time against the gateway's
   * configured inbound_token.
   *
   * Fails closed: no configured token means anyone who can reach the
   * gateway URL could inject messages as any user.
   */
  async verifyWebhook(
    payload: any,
    headers: Record<string, string>,
    config: Record<string, any>,
  ): Promise<boolean> {
    const expected = config?.inbound_token;
    if (!expected) return false;

    const authz = headers['authorization'] || '';
    const presented = authz.startsWith('Bearer ')
      ? authz.slice(7).trim()
      : headers['x-bridge-token'] || '';
    if (!presented) return false;

    const a = Buffer.from(String(presented));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
