import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class DiscordAdapter extends BaseAdapter {
  private readonly logger = new Logger(DiscordAdapter.name);
  readonly type = 'discord';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    return {
      text: rawPayload.content || '',
      userId: rawPayload.author?.id || 'unknown',
      threadId: rawPayload.channel_id,
      metadata: { guildId: rawPayload.guild_id, channelId: rawPayload.channel_id, source: 'discord' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { content: response.text.substring(0, 2000) }; // Discord 2000 char limit
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      await (fetch as any)(`https://discord.com/api/v10/channels/${threadContext?.channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${config.bot_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formattedResponse),
      });
    } catch (error) {
      this.logger.error(`Discord send failed: ${error.message}`);
    }
  }
}
