import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

@Injectable()
export class SlackAdapter extends BaseAdapter {
  private readonly logger = new Logger(SlackAdapter.name);
  readonly type = 'slack';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const event = rawPayload.event || rawPayload;
    return {
      text: event.text || '',
      userId: event.user || 'unknown',
      threadId: event.thread_ts || event.ts,
      metadata: { channel: event.channel, ts: event.ts, source: 'slack' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    // POST to Slack Web API chat.postMessage
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.bot_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: threadContext?.channel,
          text: formattedResponse.text,
          thread_ts: threadContext?.threadId,
        }),
      });
    } catch (error) {
      this.logger.error(`Slack send failed: ${error.message}`);
    }
  }

  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
    // Fail closed: an unconfigured signing secret means we cannot tell a
    // real Slack event from a forged one, so we refuse rather than run
    // the agent on it.
    if (!config.signing_secret) return false;
    const timestamp = headers['x-slack-request-timestamp'];
    const signature = headers['x-slack-signature'];
    if (!timestamp || !signature) return false;
    const sigBasestring = `v0:${timestamp}:${rawBody ?? JSON.stringify(payload)}`;
    const mySignature = 'v0=' + crypto.createHmac('sha256', config.signing_secret).update(sigBasestring).digest('hex');
    // timingSafeEqual throws on a length mismatch, which a forged header
    // can trivially cause — compare lengths first so a bad signature is
    // a rejection rather than a 500.
    const a = Buffer.from(mySignature);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Slack event payloads carry the workspace (team) id at the top level
   * (`team_id`), and events forwarded from other workspaces carry it on
   * the event itself (`event.team`). Used to resolve multi-workspace
   * installations to the installing workspace's own bot token.
   */
  extractTenantId(rawPayload: any): string | undefined {
    return (
      rawPayload?.team_id ||
      rawPayload?.event?.team ||
      rawPayload?.team?.id ||
      undefined
    );
  }
}