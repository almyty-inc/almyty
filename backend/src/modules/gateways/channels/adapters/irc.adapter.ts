import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

/**
 * IRC via a self-hosted HTTP<->IRC bridge (matterbridge in API mode, an
 * Ergo webhook shim, or anything honoring this contract). almyty does
 * not speak the IRC wire protocol itself.
 *
 * Bridge contract:
 *
 * Outbound (almyty -> bridge): POST {config.webhook_url}
 *   headers: Content-Type: application/json
 *            Authorization: Bearer {config.bridge_token}   (when configured)
 *   body: { "text": string,      // message body; the bridge is responsible
 *                                // for splitting on newlines and enforcing
 *                                // the 512-byte IRC line limit
 *           "channel": string,   // "#channel" or a nick for a private msg
 *           "username": string } // nick to relay as (config.nick, "bot")
 *
 * Inbound (bridge -> almyty channel webhook): POST JSON
 *   { "text" | "message": string,
 *     "nick" | "username" | "from": string,
 *     "channel": string, "server"?: string }
 *   When config.inbound_token is set the bridge must present it as
 *   "Authorization: Bearer <token>" or "X-Bridge-Token: <token>";
 *   requests without a matching token are rejected.
 */
@Injectable()
export class IrcAdapter extends BaseAdapter {
  private readonly logger = new Logger(IrcAdapter.name);
  readonly type = 'irc';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // IRC via webhook bridge format (e.g., Ergo ircd webhook, matterbridge, etc.)
    return {
      text: rawPayload.text || rawPayload.message || '',
      userId: rawPayload.nick || rawPayload.username || rawPayload.from || 'unknown',
      threadId: rawPayload.channel || undefined,
      metadata: {
        channel: rawPayload.channel,
        server: rawPayload.server,
        source: 'irc',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const webhookUrl = config.webhook_url;
      if (!webhookUrl) {
        this.logger.warn('IRC: webhook_url not configured');
        return;
      }

      const body: any = {
        text: formattedResponse.text,
        channel: threadContext?.threadId || config.channel,
        username: config.nick || 'bot',
      };

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.bridge_token) {
        headers['Authorization'] = `Bearer ${config.bridge_token}`;
      }

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const res = await (fetch as any)(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (res && res.ok === false) {
        this.logger.error(`IRC send failed: bridge returned HTTP ${res.status}`);
      }
    } catch (error) {
      this.logger.error(`IRC send failed: ${error.message}`);
    }
  }

  /**
   * Shared-token check for inbound bridge posts (see contract above).
   * Skipped when `inbound_token` is not configured.
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    const expected = config.inbound_token;
    if (!expected) return true;

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