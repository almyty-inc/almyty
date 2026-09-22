import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class DiscordAdapter extends BaseAdapter {
  private readonly logger = new Logger(DiscordAdapter.name);
  readonly type = 'discord';

  /**
   * Discord inbound never arrives as an HTTP webhook: the bot holds an
   * authenticated gateway websocket (discord-gateway.transport.ts) and
   * messages come down that socket. There is no signature to check
   * because there is no untrusted HTTP entry point.
   */
  protected readonly inboundIsUnauthenticatedByDesign = true;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    return {
      text: rawPayload.content || '',
      userId: rawPayload.author?.id || 'unknown',
      threadId: rawPayload.channel_id,
      metadata: { guildId: rawPayload.guild_id, channelId: rawPayload.channel_id, source: 'discord' },
    };
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

  formatOutbound(response: AdapterResponse): any {
    return { content: response.text.substring(0, 2000) }; // Discord 2000 char limit
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
