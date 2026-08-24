import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

@Injectable()
export class MatrixAdapter extends BaseAdapter {
  private readonly logger = new Logger(MatrixAdapter.name);
  readonly type = 'matrix';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Matrix client-server API event format
    const event = rawPayload;
    const content = event.content || {};
    return {
      text: content.body || '',
      userId: event.sender || 'unknown',
      threadId: event.room_id || undefined,
      metadata: {
        eventId: event.event_id,
        roomId: event.room_id,
        eventType: event.type,
        source: 'matrix',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return {
      msgtype: 'm.text',
      body: response.text,
    };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const homeserverUrl = config.homeserver_url;
      const accessToken = config.access_token;
      const roomId = threadContext?.threadId || config.room_id;

      if (!homeserverUrl || !accessToken || !roomId) {
        this.logger.warn('Matrix: homeserver_url, access_token, or room_id not configured');
        return;
      }

      const txnId = `m${Date.now()}`;
      const encodedRoomId = encodeURIComponent(roomId);
      const url = `${homeserverUrl}/_matrix/client/r0/rooms/${encodedRoomId}/send/m.room.message/${txnId}`;

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formattedResponse),
      });
    } catch (error) {
      this.logger.error(`Matrix send failed: ${error.message}`);
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
