import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

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

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.logger.error(`IRC send failed: ${error.message}`);
    }
  }
}
