import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class MicrosoftTeamsAdapter extends BaseAdapter {
  private readonly logger = new Logger(MicrosoftTeamsAdapter.name);
  readonly type = 'microsoft_teams';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Bot Framework activity format
    const activity = rawPayload;
    return {
      text: activity.text || '',
      userId: activity.from?.id || activity.from?.aadObjectId || 'unknown',
      threadId: activity.conversation?.id || undefined,
      metadata: {
        activityId: activity.id,
        conversationId: activity.conversation?.id,
        channelId: activity.channelId,
        serviceUrl: activity.serviceUrl,
        tenantId: activity.channelData?.tenant?.id,
        source: 'microsoft_teams',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return {
      type: 'message',
      text: response.text,
    };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const serviceUrl = threadContext?.metadata?.serviceUrl || config.service_url;
      const conversationId = threadContext?.metadata?.conversationId || threadContext?.threadId;

      if (!serviceUrl || !conversationId) {
        this.logger.warn('Microsoft Teams: missing serviceUrl or conversationId');
        return;
      }

      // Get access token using bot credentials
      const token = await this.getAccessToken(config.bot_id, config.bot_password);
      if (!token) {
        this.logger.error('Microsoft Teams: failed to get access token');
        return;
      }

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const url = `${serviceUrl}/v3/conversations/${conversationId}/activities`;
      await (fetch as any)(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formattedResponse),
      });
    } catch (error) {
      this.logger.error(`Microsoft Teams send failed: ${error.message}`);
    }
  }

  private async getAccessToken(botId: string, botPassword: string): Promise<string | null> {
    try {
      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const res = await (fetch as any)('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: botId,
          client_secret: botPassword,
          scope: 'https://api.botframework.com/.default',
        }).toString(),
      });
      const data = await res.json();
      return data.access_token || null;
    } catch (err) {
      this.logger.error(`Failed to get Teams access token: ${err.message}`);
      return null;
    }
  }
}
