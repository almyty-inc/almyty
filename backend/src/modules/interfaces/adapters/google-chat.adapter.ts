import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class GoogleChatAdapter extends BaseAdapter {
  private readonly logger = new Logger(GoogleChatAdapter.name);
  readonly type = 'google_chat';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const message = rawPayload.message || rawPayload;
    return {
      text: message.text || message.argumentText || '',
      userId: message.sender?.name || message.sender?.displayName || 'unknown',
      threadId: message.thread?.name || undefined,
      metadata: {
        spaceId: rawPayload.space?.name,
        spaceName: rawPayload.space?.displayName,
        messageId: message.name,
        source: 'google_chat',
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
        this.logger.warn('Google Chat webhook URL not configured');
        return;
      }

      const body: any = { text: formattedResponse.text };
      if (threadContext?.threadId) {
        body.thread = { name: threadContext.threadId };
      }

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.logger.error(`Google Chat send failed: ${error.message}`);
    }
  }

  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    // Google Chat uses bearer tokens for verification
    if (!config.verification_token) return true;
    const token = headers['authorization']?.replace('Bearer ', '');
    return token === config.verification_token;
  }
}
