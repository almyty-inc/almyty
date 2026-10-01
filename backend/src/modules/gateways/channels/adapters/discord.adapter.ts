import { Injectable, Logger } from '@nestjs/common';
import {
  BaseAdapter,
  NormalizedMessage,
  AdapterResponse,
  AttachmentFetchLimits,
  FetchedAttachment,
  InboundAttachment,
} from './base.adapter';
import { isImage, textWithMedia } from '../reply-media';

@Injectable()
export class DiscordAdapter extends BaseAdapter {
  private readonly logger = new Logger(DiscordAdapter.name);
  readonly type = 'discord';

  /** Discord's attachment CDN. A link elsewhere in a payload is not fetched. */
  static readonly FILE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
  /** Embeds one message carries. */
  static readonly MAX_EMBEDS = 10;

  /**
   * Discord inbound never arrives as an HTTP webhook: the bot holds an
   * authenticated gateway websocket (discord-gateway.transport.ts) and
   * messages come down that socket. There is no signature to check
   * because there is no untrusted HTTP entry point.
   */
  protected readonly inboundIsUnauthenticatedByDesign = true;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const attachments: InboundAttachment[] = (Array.isArray(rawPayload.attachments) ? rawPayload.attachments : [])
      .filter((a: any) => a && typeof a.url === 'string')
      .map((a: any) => ({
        url: a.url,
        type: a.content_type || 'application/octet-stream',
        name: a.filename || 'attachment',
        ...(typeof a.size === 'number' ? { size: a.size } : {}),
      }));
    const author = rawPayload.author;
    return {
      text: rawPayload.content || '',
      userId: rawPayload.author?.id || 'unknown',
      threadId: rawPayload.channel_id,
      ...(attachments.length ? { attachments } : {}),
      ...(author?.id
        ? { sender: { id: author.id, name: rawPayload.member?.nick || author.global_name || author.username || undefined } }
        : {}),
      // A server channel has its members in it; a direct message has one.
      group: !!rawPayload.guild_id,
      metadata: { guildId: rawPayload.guild_id, channelId: rawPayload.channel_id, source: 'discord' },
    };
  }

  /** Discord's CDN links are signed and public; fetched with no token, and only from the CDN. */
  async fetchAttachment(
    attachment: InboundAttachment,
    _config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    if (!BaseAdapter.onHost(attachment.url, DiscordAdapter.FILE_HOSTS)) return null;
    return this.fetchBytes(attachment.url!, limits);
  }

  /**
   * The message snowflake. Discord inbound arrives over the gateway
   * websocket rather than an HTTP webhook, so it is not retried by
   * Discord — but a reconnect can replay a buffered MESSAGE_CREATE, and
   * the snowflake is stable across that.
   */
  deliveryId(rawPayload: any): string | undefined {
    return rawPayload?.id ? `discord:${rawPayload.id}` : undefined;
  }

  /** Images go as embeds Discord shows under the text; other files stay links. */
  formatOutbound(response: AdapterResponse): any {
    const images = (response.attachments ?? []).filter(isImage).slice(0, DiscordAdapter.MAX_EMBEDS);
    const content = textWithMedia(response, images).substring(0, 2000); // Discord 2000 char limit
    return images.length ? { content, embeds: images.map((image) => ({ image: { url: image.url } })) } : { content };
  }

  /**
   * Create a message in the channel.
   *
   * Discord's REST API is HTTP-shaped: 200 with the created message on
   * success, and a 4xx/5xx carrying `{code, message, errors}` on
   * failure — 403 `Missing Access` when the bot cannot see the channel,
   * 401 `401: Unauthorized` on a revoked token, 429 when rate limited.
   * There is no body-level `ok` field, so the status is the verdict and
   * `message`/`code` are the wording to keep. Same check
   * `testConnection` makes against users/@me.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(`https://discord.com/api/v10/channels/${threadContext?.channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${config.bot_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formattedResponse),
    });

    if (this.httpRejected(res)) {
      const body = await this.readJsonBody(res);
      const detail = body?.message ? `${body.message}` : '';
      this.sendFailed(
        `create-message returned HTTP ${this.httpStatus(res)}` +
          `${detail ? ` — ${detail}` : ''}${body?.code ? ` (code ${body.code})` : ''}`,
      );
    }
  }
}
