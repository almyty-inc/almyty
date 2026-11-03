import { Injectable, Logger } from '@nestjs/common';
import {
  ActionPress,
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

  /**
   * Images go as embeds Discord shows under the text; other files stay links.
   * Buttons (Approve, Reject) go as one action row of button components,
   * each with its action's id as its custom_id (at most 100 characters).
   */
  formatOutbound(response: AdapterResponse): any {
    const images = (response.attachments ?? []).filter(isImage).slice(0, DiscordAdapter.MAX_EMBEDS);
    const content = textWithMedia(response, images).substring(0, 2000); // Discord 2000 char limit
    const buttons = (response.actions ?? [])
      .filter((a) => a && typeof a.id === 'string' && a.id.length <= 100)
      .slice(0, 5)
      .map((a) => ({
        type: 2,
        // 3 is green (success), 4 red (danger), 2 grey (secondary).
        style: a.style === 'primary' ? 3 : a.style === 'danger' ? 4 : 2,
        label: a.label.slice(0, 80),
        custom_id: a.id,
      }));
    return {
      content,
      ...(images.length ? { embeds: images.map((image) => ({ image: { url: image.url } })) } : {}),
      ...(buttons.length ? { components: [{ type: 1, components: buttons }] } : {}),
    };
  }

  /**
   * A pressed button: an INTERACTION_CREATE of type 3 (a message
   * component) that came down the bot's authenticated gateway socket
   * (discord-gateway.transport.ts), with the interaction's id and token to
   * answer it by. In a server the presser is `member.user`; in a direct
   * message, `user`.
   */
  actionOf(rawPayload: any): ActionPress | null {
    if (rawPayload?.type !== 3 || typeof rawPayload?.token !== 'string' || typeof rawPayload?.data?.custom_id !== 'string') return null;
    const user = rawPayload.member?.user ?? rawPayload.user;
    if (!user?.id) return null;
    return {
      data: rawPayload.data.custom_id,
      userId: String(user.id),
      userName: rawPayload.member?.nick || user.global_name || user.username || undefined,
      group: !!rawPayload.guild_id,
      context: {
        interactionId: rawPayload.id,
        interactionToken: rawPayload.token,
        channelId: rawPayload.channel_id,
        messageContent: rawPayload.message?.content,
      },
    };
  }

  /**
   * Answer the interaction (it must be answered within three seconds).
   * Settled, the message is updated in place: its text and the outcome,
   * with the buttons taken off (UPDATE_MESSAGE). Not settled, the presser
   * alone sees the answer (an ephemeral CHANNEL_MESSAGE_WITH_SOURCE).
   */
  async answerAction(_config: Record<string, any>, press: ActionPress, text: string, settled: boolean): Promise<void> {
    const { interactionId, interactionToken, messageContent } = press.context ?? {};
    if (!interactionId || !interactionToken) this.sendFailed('the button press carried no interaction to answer');
    const original = typeof messageContent === 'string' ? messageContent : '';
    const body = settled
      ? { type: 7, data: { content: (original ? `${original}\n\n${text}` : text).substring(0, 2000), components: [] } }
      : { type: 4, data: { content: text.substring(0, 2000), flags: 64 } };
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(
      `https://discord.com/api/v10/interactions/${encodeURIComponent(String(interactionId))}/${encodeURIComponent(String(interactionToken))}/callback`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (this.httpRejected(res)) {
      const answer = await this.readJsonBody(res);
      this.sendFailed(`the interaction callback returned HTTP ${this.httpStatus(res)}${answer?.message ? ` — ${answer.message}` : ''}`);
    }
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
