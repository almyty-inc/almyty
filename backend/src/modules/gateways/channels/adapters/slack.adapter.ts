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

  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    if (!config.signing_secret) return true;
    const timestamp = headers['x-slack-request-timestamp'];
    const signature = headers['x-slack-signature'];
    if (!timestamp || !signature) return false;
    const sigBasestring = `v0:${timestamp}:${JSON.stringify(payload)}`;
    const mySignature = 'v0=' + crypto.createHmac('sha256', config.signing_secret).update(sigBasestring).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  }
}
