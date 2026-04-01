import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class SignalAdapter extends BaseAdapter {
  private readonly logger = new Logger(SignalAdapter.name);
  readonly type = 'signal';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // signal-cli REST API format
    const envelope = rawPayload.envelope || rawPayload;
    const dataMessage = envelope.dataMessage || {};
    return {
      text: dataMessage.message || dataMessage.body || '',
      userId: envelope.source || envelope.sourceNumber || 'unknown',
      threadId: dataMessage.groupInfo?.groupId || envelope.source || undefined,
      metadata: {
        timestamp: dataMessage.timestamp || envelope.timestamp,
        groupId: dataMessage.groupInfo?.groupId,
        source: 'signal',
      },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { message: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const apiUrl = config.api_url;
      const phoneNumber = config.phone_number;
      if (!apiUrl || !phoneNumber) {
        this.logger.warn('Signal: api_url or phone_number not configured');
        return;
      }

      const recipient = threadContext?.userId || threadContext?.metadata?.groupId;
      if (!recipient) {
        this.logger.warn('Signal: no recipient available');
        return;
      }

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const endpoint = threadContext?.metadata?.groupId
        ? `${apiUrl}/v2/send`
        : `${apiUrl}/v2/send`;

      const body: any = {
        message: formattedResponse.message,
        number: phoneNumber,
      };

      if (threadContext?.metadata?.groupId) {
        body.recipients = [threadContext.metadata.groupId];
      } else {
        body.recipients = [recipient];
      }

      await (fetch as any)(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.logger.error(`Signal send failed: ${error.message}`);
    }
  }
}
