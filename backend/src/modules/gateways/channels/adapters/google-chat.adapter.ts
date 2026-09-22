import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';

@Injectable()
export class GoogleChatAdapter extends BaseAdapter {
  private readonly logger = new Logger(GoogleChatAdapter.name);
  readonly type = 'google_chat';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const message = rawPayload.message || rawPayload;
    return {
      text: message.text || message.argumentText || '',
      userId: message.sender?.name || message.sender?.displayName || 'unknown',
      threadId: message.thread?.name || undefined,
      metadata: {
        spaceId: rawPayload.space?.name,
        spaceName: rawPayload.space?.displayName,
        messageId: message.name,
        source: 'google_chat',
      },
    };
  }

  /**
   * The message's resource name ("spaces/AAA/messages/BBB"), which
   * Google Chat repeats on a redelivery of the same event.
   */
  deliveryId(rawPayload: any): string | undefined {
    const message = rawPayload?.message ?? rawPayload;
    return message?.name ? `google_chat:${message.name}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text };
  }

  /**
   * Post the reply to the space's incoming webhook.
   *
   * Google Chat's REST surface is HTTP-shaped: 200 with the created
   * Message resource on success, and a 4xx carrying
   * `{error: {code, message, status}}` on failure — 404
   * `NOT_FOUND` for a deleted space, 400 `INVALID_ARGUMENT` for a
   * thread name from another space, 403 once the webhook is revoked. So
   * the status is the verdict and `error.message`/`error.status` are
   * the wording to keep.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const webhookUrl = config.webhook_url;
    if (!webhookUrl) {
      this.sendFailed('webhook_url is not configured, so there is nowhere to send the reply');
    }

    const body: any = { text: formattedResponse.text };
    if (threadContext?.threadId) {
      body.thread = { name: threadContext.threadId };
    }

    this.assertEgress(webhookUrl);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(webhookUrl, this.egressInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    const answer = await this.readJsonBody(res);
    const error = answer?.error;
    if (this.httpRejected(res) || error) {
      const detail = error?.message ?? `HTTP ${this.httpStatus(res)}`;
      this.sendFailed(
        `the space webhook refused the reply: ${detail}${error?.status ? ` (${error.status})` : ''}`,
      );
    }
  }

  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>): Promise<boolean> {
    // Google Chat uses bearer tokens for verification
    // Fail closed: without the verification token there is nothing to
    // distinguish Google Chat from any other caller.
    if (!config.verification_token) return false;
    const token = headers['authorization']?.replace('Bearer ', '');
    return token === config.verification_token;
  }
}
