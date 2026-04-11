import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class WhatsAppAdapter extends BaseAdapter {
  private readonly logger = new Logger(WhatsAppAdapter.name);
  readonly type = 'whatsapp';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    // Twilio WhatsApp format
    return {
      text: rawPayload.Body || '',
      userId: rawPayload.From || 'unknown',
      threadId: rawPayload.From, // Use phone number as thread
      metadata: { from: rawPayload.From, to: rawPayload.To, messageSid: rawPayload.MessageSid, source: 'whatsapp' },
    };
  }

  formatOutbound(response: AdapterResponse): any {
    return { body: response.text };
  }

  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    try {
      const accountSid = config.twilio_account_sid;
      const authToken = config.twilio_auth_token;
      const from = config.phone_number;
      const to = threadContext?.from;

      const fetch = globalThis.fetch || (await import('node-fetch')).default;
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      await (fetch as any)(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: `whatsapp:${from}`,
          To: to,
          Body: formattedResponse.body,
        }).toString(),
      });
    } catch (error) {
      this.logger.error(`WhatsApp send failed: ${error.message}`);
    }
  }
}
