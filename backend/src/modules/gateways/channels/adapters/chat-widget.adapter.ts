import { Injectable } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class ChatWidgetAdapter extends BaseAdapter {
  readonly type = 'chat_widget';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    return {
      text: rawPayload.message || rawPayload.text || '',
      userId: rawPayload.userId || rawPayload.sessionId || 'anonymous',
      threadId: rawPayload.threadId || rawPayload.sessionId,
      metadata: { source: 'chat_widget' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { message: response.text, attachments: response.attachments };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    // Widget uses SSE/polling — response is returned directly, no push needed
  }
}
