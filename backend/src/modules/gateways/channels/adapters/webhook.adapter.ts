import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

@Injectable()
export class WebhookAdapter extends BaseAdapter {
  private readonly logger = new Logger(WebhookAdapter.name);
  readonly type = 'webhook';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    return {
      text: rawPayload.text || rawPayload.message || rawPayload.input || JSON.stringify(rawPayload),
      userId: rawPayload.userId || 'webhook',
      threadId: rawPayload.threadId || rawPayload.requestId,
      metadata: { source: 'webhook', raw: rawPayload },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text, attachments: response.attachments };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    if (!config.callback_url) return;
    try {
      const body = JSON.stringify(formattedResponse);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      // HMAC signature for verification
      if (config.secret) {
        const signature = crypto.createHmac('sha256', config.secret).update(body).digest('hex');
        headers['X-Webhook-Signature'] = signature;
      }

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)(config.callback_url, { method: 'POST', headers, body });
    } catch (error) {
      this.logger.error(`Webhook callback failed: ${error.message}`);
    }
  }

  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
    if (!config.secret) return true;
    const signature = headers['x-webhook-signature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', config.secret).update(rawBody ?? JSON.stringify(payload)).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}
