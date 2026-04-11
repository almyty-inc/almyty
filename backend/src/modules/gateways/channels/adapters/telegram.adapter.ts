import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class TelegramAdapter extends BaseAdapter {
  private readonly logger = new Logger(TelegramAdapter.name);
  readonly type = 'telegram';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const message = rawPayload.message || rawPayload;
    return {
      text: message.text || '',
      userId: String(message.from?.id || 'unknown'),
      threadId: String(message.chat?.id),
      metadata: { chatId: message.chat?.id, messageId: message.message_id, source: 'telegram' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: threadContext?.chatId,
          text: formattedResponse.text,
        }),
      });
    } catch (error) {
      this.logger.error(`Telegram send failed: ${error.message}`);
    }
  }
}
