import { Injectable, Logger } from '@nestjs/common';
import {
  ActionPress,
  BaseAdapter,
  NormalizedMessage,
  AdapterResponse,
  AttachmentFetchLimits,
  FetchedAttachment,
  InboundAttachment,
  OutboundAttachment,
} from './base.adapter';
import { textWithMedia } from '../reply-media';
import { ResponseTooLargeError, safeFetch } from '../../../../common/security/safe-fetch';
import * as crypto from 'crypto';

@Injectable()
export class TelegramAdapter extends BaseAdapter {
  private readonly logger = new Logger(TelegramAdapter.name);
  readonly type = 'telegram';

  static readonly API = 'https://api.telegram.org';
  /** The most media one reply sends; each is a message of its own. */
  static readonly MAX_MEDIA = 5;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const message = rawPayload.message || rawPayload;
    const from = message.from;
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || undefined;
    const attachments = TelegramAdapter.attachmentsOf(message);
    return {
      // A photo or a document comes with a caption rather than text.
      text: message.text || message.caption || '',
      userId: String(message.from?.id || 'unknown'),
      threadId: String(message.chat?.id),
      ...(attachments.length ? { attachments } : {}),
      ...(from?.id !== undefined ? { sender: { id: String(from.id), name } } : {}),
      group: ['group', 'supergroup', 'channel'].includes(message.chat?.type),
      metadata: {
        chatId: message.chat?.id,
        messageId: message.message_id,
        source: 'telegram',
        // The message this one replies to, so "yes" under an approval finds it.
        ...(message.reply_to_message ? { replyToText: message.reply_to_message.text || message.reply_to_message.caption || '' } : {}),
      },
    };
  }

  /**
   * The files a message carries, by Telegram file_id: the largest size of
   * a photo (the last entry of `photo`), and a document as sent.
   */
  static attachmentsOf(message: any): InboundAttachment[] {
    const out: InboundAttachment[] = [];
    const photo = Array.isArray(message?.photo) ? message.photo[message.photo.length - 1] : null;
    if (photo?.file_id) {
      out.push({ ref: photo.file_id, type: 'image/jpeg', name: 'photo.jpg', ...(photo.file_size ? { size: photo.file_size } : {}) });
    }
    const doc = message?.document;
    if (doc?.file_id) {
      out.push({
        ref: doc.file_id,
        type: doc.mime_type || 'application/octet-stream',
        name: doc.file_name || 'document',
        ...(doc.file_size ? { size: doc.file_size } : {}),
      });
    }
    return out;
  }

  /**
   * A file_id becomes bytes in two Bot API calls: getFile names the file's
   * path, and the file is read from the bot's file URL. Both carry the bot
   * token in the path, which is Telegram's scheme, so neither URL is ever
   * logged or put in an error.
   */
  async fetchAttachment(
    attachment: InboundAttachment,
    config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    if (!attachment.ref || !config.bot_token) return null;
    if (attachment.size && attachment.size > limits.maxBytes) throw new ResponseTooLargeError(limits.maxBytes);
    const token = encodeURIComponent(String(config.bot_token)).replace(/%3A/gi, ':');
    const res = await safeFetch(`${TelegramAdapter.API}/bot${token}/getFile?file_id=${encodeURIComponent(attachment.ref)}`, {
      method: 'GET',
      maxBytes: 64 * 1024,
      timeoutMs: limits.timeoutMs,
    });
    const body = await this.readJsonBody(res);
    const path = body?.ok === true ? body.result?.file_path : undefined;
    if (typeof path !== 'string' || !path || path.includes('..')) throw new Error('getFile did not name the file');
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return this.fetchBytes(`${TelegramAdapter.API}/file/bot${token}/${encodedPath}`, limits);
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

  /**
   * Media Telegram takes by URL: a photo (sendPhoto) and, as a document,
   * a GIF or a PDF (sendDocument by URL takes only those). Anything else
   * stays a link in the text.
   */
  formatOutbound(response: AdapterResponse): any {
    const media: Array<{ method: 'sendPhoto' | 'sendDocument'; url: string }> = [];
    const sent: OutboundAttachment[] = [];
    for (const a of response.attachments ?? []) {
      if (media.length >= TelegramAdapter.MAX_MEDIA) break;
      const method = /^image\/(png|jpeg|webp)$/.test(a.type)
        ? 'sendPhoto'
        : a.type === 'image/gif' || a.type === 'application/pdf'
          ? 'sendDocument'
          : null;
      if (!method) continue;
      media.push({ method, url: a.url });
      sent.push(a);
    }
    const text = textWithMedia(response, sent);
    const markup = TelegramAdapter.inlineKeyboard(response.actions);
    return { text, ...(media.length ? { media } : {}), ...(markup ? { reply_markup: markup } : {}) };
  }

  /** Buttons as an inline keyboard on one row; `callback_data` is the action's id (at most 64 bytes). */
  static inlineKeyboard(actions: AdapterResponse['actions']): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | null {
    const buttons = (actions ?? [])
      .filter((a) => a && typeof a.id === 'string' && Buffer.byteLength(a.id) <= 64)
      .map((a) => ({ text: a.label, callback_data: a.id }));
    return buttons.length ? { inline_keyboard: [buttons] } : null;
  }

  /**
   * Bot API sendMessage, then one sendPhoto/sendDocument per file.
   *
   * Every Bot API response is `{ok: boolean}` — `{ok: true, result: {...}}`
   * on success, `{ok: false, error_code, description: "Bad Request: chat
   * not found" | "Forbidden: bot was blocked by the user" | ...}` on
   * failure — so `ok` is the verdict and `description` is the wording
   * to keep. Same pair `testConnection` reads off getMe.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const chatId = threadContext?.chatId;
    if (formattedResponse.text || !formattedResponse.media?.length) {
      await this.call(config, 'sendMessage', {
        chat_id: chatId,
        text: formattedResponse.text,
        ...(formattedResponse.reply_markup ? { reply_markup: formattedResponse.reply_markup } : {}),
      });
    }
    for (const item of Array.isArray(formattedResponse.media) ? formattedResponse.media : []) {
      const field = item.method === 'sendPhoto' ? 'photo' : 'document';
      await this.call(config, item.method, { chat_id: chatId, [field]: item.url });
    }
  }

  /** A pressed inline button: a callback_query, with who pressed it and the message it sat on. */
  actionOf(rawPayload: any): ActionPress | null {
    const query = rawPayload?.callback_query;
    if (!query || typeof query.data !== 'string' || query.from?.id === undefined) return null;
    const from = query.from;
    return {
      data: query.data,
      userId: String(from.id),
      userName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || undefined,
      group: ['group', 'supergroup', 'channel'].includes(query.message?.chat?.type),
      context: { callbackQueryId: query.id, chatId: query.message?.chat?.id, messageId: query.message?.message_id },
    };
  }

  /**
   * answerCallbackQuery stops the button spinning and shows `text` to the
   * presser. Settled, the buttons come off the message and the outcome is
   * said in the chat; not settled, the presser alone sees it, as an alert.
   */
  async answerAction(config: Record<string, any>, press: ActionPress, text: string, settled: boolean): Promise<void> {
    const { callbackQueryId, chatId, messageId } = press.context ?? {};
    if (callbackQueryId) {
      await this.call(config, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: text.slice(0, 200),
        ...(settled ? {} : { show_alert: true }),
      });
    }
    if (!settled || chatId === undefined || chatId === null) return;
    if (messageId !== undefined && messageId !== null) {
      // The buttons go; a message they were already taken off is fine.
      await this.call(config, 'editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
    }
    await this.call(config, 'sendMessage', { chat_id: chatId, text });
  }

  private async call(config: Record<string, any>, method: string, payload: Record<string, unknown>): Promise<void> {
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(`${TelegramAdapter.API}/bot${config.bot_token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = await this.readJsonBody(res);
    if (body?.ok !== true) {
      const detail =
        body?.description ??
        (this.httpRejected(res)
          ? `HTTP ${this.httpStatus(res)}`
          : `${method} did not confirm the message`);
      this.sendFailed(
        `${method} refused the reply: ${detail}${body?.error_code ? ` (error_code ${body.error_code})` : ''}`,
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
