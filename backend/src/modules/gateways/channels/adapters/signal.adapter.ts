import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
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
    const attachments = Array.isArray(dataMessage.attachments) && dataMessage.attachments.length
      ? dataMessage.attachments.map((a: any) => ({
          // The bridge exposes attachments by id under /v1/attachments/<id>
          url: a.id || '',
          type: a.contentType || 'application/octet-stream',
          name: a.filename || a.id || 'attachment',
        }))
      : undefined;
    return {
      text: dataMessage.message || dataMessage.body || '',
      userId: envelope.source || envelope.sourceNumber || envelope.sourceUuid || 'unknown',
      threadId: dataMessage.groupInfo?.groupId || envelope.source || envelope.sourceNumber || undefined,
      attachments,
      metadata: {
        timestamp: dataMessage.timestamp || envelope.timestamp,
        groupId: dataMessage.groupInfo?.groupId,
        sourceName: envelope.sourceName,
        sourceUuid: envelope.sourceUuid,
        source: 'signal',
      },
    };
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

  formatOutbound(response: AdapterResponse): any {
    return { message: response.text };
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

    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(`${apiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: formattedResponse.message,
        number: phoneNumber,
        recipients: [recipient],
      }),
    });

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