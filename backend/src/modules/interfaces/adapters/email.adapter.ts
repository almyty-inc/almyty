import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class EmailAdapter extends BaseAdapter {
  private readonly logger = new Logger(EmailAdapter.name);
  readonly type = 'email';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    return {
      text: rawPayload.text || rawPayload.html || rawPayload.body || '',
      userId: rawPayload.from || rawPayload.sender || 'unknown',
      threadId: rawPayload.messageId || rawPayload.subject,
      metadata: { subject: rawPayload.subject, from: rawPayload.from, to: rawPayload.to, source: 'email' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { html: response.text, text: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    // Send via Resend or configured email provider
    try {
      if (config.resend_api_key) {
        const fetch = globalThis.fetch || (await import('node-fetch')).default;
        await (fetch as any)('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.resend_api_key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: config.reply_from || 'agent@almyty.com',
            to: threadContext?.from,
            subject: `Re: ${threadContext?.subject || 'Agent Response'}`,
            html: formattedResponse.html,
          }),
        });
      }
    } catch (error) {
      this.logger.error(`Email send failed: ${error.message}`);
    }
  }
}
