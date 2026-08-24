import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

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

  /**
   * Telegram does not sign webhook payloads. Instead setWebhook accepts
   * a secret_token which Telegram then echoes back in the
   * X-Telegram-Bot-Api-Secret-Token header on every inbound update. The
   * registrar generates one per gateway and stores it as
   * `webhook_secret_token`; this compares it in constant time.
   *
   * Fails closed: no stored token, or no header, means we cannot tell
   * Telegram from any other caller, so the update is refused.
   */
  async verifyWebhook(
    payload: any,
    headers: Record<string, string>,
    config: Record<string, any>,
  ): Promise<boolean> {
    const expected = config?.webhook_secret_token;
    if (!expected) return false;

    const presented = headers['x-telegram-bot-api-secret-token'];
    if (!presented) return false;

    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(presented));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
