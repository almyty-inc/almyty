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
import { isImage, textWithMedia } from '../reply-media';
import * as crypto from 'crypto';

/**
 * Signal via a self-hosted signal-cli REST bridge
 * (https://github.com/bbernhard/signal-cli-rest-api). almyty does not
 * speak the Signal protocol itself; `config.api_url` points at the
 * bridge and `config.phone_number` is the bridge-registered account.
 *
 * Outbound (almyty -> bridge): POST {api_url}/v2/send
 *   { "message": string,
 *     "number": string,              // our registered account (sender)
 *     "recipients": [string] }       // E.164 number, or "group.<id>" for
 *                                    // a group (the id from GET /v1/groups)
 *
 * Inbound (bridge -> almyty): the envelope shape produced by
 * GET /v1/receive/{number} (or the bridge's json-rpc / websocket modes):
 *   { "envelope": {
 *       "source": "+4915...", "sourceNumber": "+4915...",
 *       "sourceUuid": "...", "sourceName": "Alice",
 *       "timestamp": 1700000000000,
 *       "dataMessage": {
 *         "timestamp": 1700000000000, "message": "text",
 *         "groupInfo": { "groupId": "<base64>", "type": "DELIVER" },
 *         "attachments": [{ "contentType": "image/png", "filename": "a.png",
 *                            "id": "<attachment id>", "size": 1234 }] },
 *       "syncMessage": { "sentMessage": { ...same as dataMessage... } } },
 *     "account": "+4915..." }
 */
@Injectable()
export class SignalAdapter extends BaseAdapter {
  private readonly logger = new Logger(SignalAdapter.name);
  readonly type = 'signal';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // signal-cli REST API format
    const envelope = rawPayload.envelope || rawPayload;
    // Note-to-self / linked-device messages arrive as syncMessage.sentMessage
    const dataMessage = envelope.dataMessage || envelope.syncMessage?.sentMessage || {};
    const attachments: InboundAttachment[] | undefined = Array.isArray(dataMessage.attachments) && dataMessage.attachments.length
      ? dataMessage.attachments
          .filter((a: any) => a?.id)
          .map((a: any) => ({
            // The bridge serves an attachment by id under /v1/attachments/<id>.
            ref: String(a.id),
            type: a.contentType || 'application/octet-stream',
            name: a.filename || a.id || 'attachment',
            ...(typeof a.size === 'number' ? { size: a.size } : {}),
          }))
      : undefined;
    const senderId = envelope.sourceUuid || envelope.source || envelope.sourceNumber;
    return {
      text: dataMessage.message || dataMessage.body || '',
      userId: envelope.source || envelope.sourceNumber || envelope.sourceUuid || 'unknown',
      threadId: dataMessage.groupInfo?.groupId || envelope.source || envelope.sourceNumber || undefined,
      ...(attachments?.length ? { attachments } : {}),
      ...(senderId ? { sender: { id: String(senderId), name: envelope.sourceName || undefined } } : {}),
      group: !!dataMessage.groupInfo?.groupId,
      metadata: {
        timestamp: dataMessage.timestamp || envelope.timestamp,
        groupId: dataMessage.groupInfo?.groupId,
        sourceName: envelope.sourceName,
        sourceUuid: envelope.sourceUuid,
        source: 'signal',
      },
    };
  }

  /** An attachment by id from the configured bridge, through the egress guard. */
  async fetchAttachment(
    attachment: InboundAttachment,
    config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    if (!attachment.ref || !config.api_url || !/^[A-Za-z0-9._-]+$/.test(attachment.ref)) return null;
    const base = String(config.api_url).replace(/(?<!\/)\/+$/, '');
    return this.fetchBytes(`${base}/v1/attachments/${encodeURIComponent(attachment.ref)}`, limits);
  }

  /**
   * Signal identifies a message by (sender, send timestamp) — that pair
   * is what a receipt addresses and what the bridge replays on
   * reconnect, so it is stable. The timestamp alone is not: two senders
   * can land on the same millisecond.
   */
  deliveryId(rawPayload: any): string | undefined {
    const envelope = rawPayload?.envelope ?? rawPayload;
    const dataMessage = envelope?.dataMessage ?? envelope?.syncMessage?.sentMessage ?? {};
    const timestamp = dataMessage?.timestamp ?? envelope?.timestamp;
    const sender = envelope?.sourceUuid ?? envelope?.source ?? envelope?.sourceNumber;
    if (timestamp === undefined || timestamp === null || !sender) return undefined;
    return `signal:${sender}:${timestamp}`;
  }

  /** Files one reply attaches; each is read and sent inline to the bridge. */
  static readonly MAX_MEDIA = 3;
  /** The largest file a reply attaches. */
  static readonly MAX_MEDIA_BYTES = 5 * 1024 * 1024;

  /**
   * Images and PDFs the reply links to are attached to the Signal message.
   * The bridge takes attachments as base64 rather than links, so each is
   * read at send time through the egress guard; one that cannot be read
   * goes as its link instead.
   */
  formatOutbound(response: AdapterResponse): any {
    const media = (response.attachments ?? [])
      .filter((a) => isImage(a) || a.type === 'application/pdf')
      .slice(0, SignalAdapter.MAX_MEDIA);
    const message = textWithMedia(response, media);
    return media.length ? { message, media } : { message };
  }

  /** The bridge's base64 attachment strings for the reply's files, and the links of any not read. */
  private async inlineMedia(media: OutboundAttachment[]): Promise<{ attachments: string[]; unread: string[] }> {
    const attachments: string[] = [];
    const unread: string[] = [];
    for (const item of media) {
      try {
        const { bytes } = await this.fetchBytes(item.url, { maxBytes: SignalAdapter.MAX_MEDIA_BYTES, timeoutMs: 20_000 });
        const filename = String(item.name || 'attachment').replace(/[;,\r\n]/g, '_');
        attachments.push(`data:${item.type};filename=${filename};base64,${bytes.toString('base64')}`);
      } catch {
        unread.push(item.name && item.name !== item.url ? `${item.name}: ${item.url}` : item.url);
      }
    }
    return { attachments, unread };
  }

  /**
   * Send through the signal-cli bridge.
   *
   * The bridge is HTTP-shaped: 201 with `{timestamp}` when signal-cli
   * accepted the message, and a 4xx/5xx carrying `{error: "..."}` — or
   * plain text, depending on which build is deployed — when it did not:
   * an unregistered `number`, a group id the account is not a member
   * of, a bridge whose account has been unlinked. So the status is the
   * verdict and the body is kept as text, because a self-hosted bridge
   * behind a proxy answers with whatever the proxy feels like.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const apiUrl = config.api_url;
    const phoneNumber = config.phone_number;
    if (!apiUrl || !phoneNumber) {
      this.sendFailed(
        `${!apiUrl ? 'api_url' : 'phone_number'} is not configured, so the reply could not be sent`,
      );
    }

    // Group replies address the group id ("group." prefixed, per the
    // bridge's send contract); direct replies address the sender.
    const groupId = threadContext?.metadata?.groupId;
    const recipient = groupId
      ? (String(groupId).startsWith('group.') ? String(groupId) : `group.${groupId}`)
      : threadContext?.userId || threadContext?.threadId;
    if (!recipient) {
      this.sendFailed('the inbound envelope carried no sender or group to reply to');
    }

    const media = Array.isArray(formattedResponse.media) ? formattedResponse.media : [];
    const inline = media.length ? await this.inlineMedia(media) : { attachments: [], unread: [] };
    const message = [formattedResponse.message, ...inline.unread].filter(Boolean).join('\n');

    const sendUrl = `${apiUrl}/v2/send`;
    this.assertEgress(sendUrl);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(sendUrl, this.egressInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        number: phoneNumber,
        recipients: [recipient],
        ...(inline.attachments.length ? { base64_attachments: inline.attachments } : {}),
      }),
    }));

    if (this.httpRejected(res)) {
      const detail = await this.readTextBody(res);
      this.sendFailed(
        `the signal-cli bridge refused the reply: HTTP ${this.httpStatus(res)}${detail ? ` — ${detail}` : ''}`,
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