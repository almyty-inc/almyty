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

  /**
   * `update_id` is Telegram's per-bot delivery counter and is repeated
   * verbatim until the update is acknowledged, which makes it the exact
   * key for the retry case. `message_id` alone is only unique within a
   * chat, so the fallback pairs it with the chat id.
   */
  deliveryId(rawPayload: any): string | undefined {
    if (rawPayload?.update_id !== undefined && rawPayload?.update_id !== null) {
      return `telegram:${rawPayload.update_id}`;
    }
    const message = rawPayload?.message ?? rawPayload;
    if (message?.message_id !== undefined && message?.message_id !== null) {
      return `telegram:${message.chat?.id ?? 'nochat'}:${message.message_id}`;
    }
    return undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text };
  }

  /**
   * Bot API sendMessage.
   *
   * Every Bot API response is `{ok: boolean}` — `{ok: true, result: {...}}`
   * on success, `{ok: false, error_code, description: "Bad Request: chat
   * not found" | "Forbidden: bot was blocked by the user" | ...}` on
   * failure — so `ok` is the verdict and `description` is the wording
   * to keep. Same pair `testConnection` reads off getMe.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: threadContext?.chatId,
        text: formattedResponse.text,
      }),
    });

    const body = await this.readJsonBody(res);
    if (body?.ok !== true) {
      const detail =
        body?.description ??
        (this.httpRejected(res)
          ? `HTTP ${this.httpStatus(res)}`
          : 'sendMessage did not confirm the message');
      this.sendFailed(
        `sendMessage refused the reply: ${detail}${body?.error_code ? ` (error_code ${body.error_code})` : ''}`,
      );
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
