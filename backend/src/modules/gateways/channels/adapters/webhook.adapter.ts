import { Injectable, Logger } from '@nestjs/common';
import { BaseAdapter, NormalizedMessage, AdapterResponse } from './base.adapter';
import * as crypto from 'crypto';

@Injectable()
export class WebhookAdapter extends BaseAdapter {
  private readonly logger = new Logger(WebhookAdapter.name);
  readonly type = 'webhook';

  normalizeInbound(rawPayload: any): NormalizedMessage {
    return {
      text: rawPayload.text || rawPayload.message || rawPayload.input || JSON.stringify(rawPayload),
      userId: rawPayload.userId || 'webhook',
      threadId: rawPayload.threadId || rawPayload.requestId,
      metadata: { source: 'webhook', raw: rawPayload },
    };
  }

  /**
   * The generic webhook has no platform behind it, so there is no id
   * this adapter can count on. When the sender supplies one we use it;
   * otherwise there is nothing stable to key on and a retry from that
   * sender is indistinguishable from a second message. Documented on
   * the endpoint rather than faked here.
   */
  deliveryId(rawPayload: any, headers?: Record<string, string>): string | undefined {
    const headerId =
      headers?.['x-delivery-id'] ?? headers?.['x-request-id'] ?? headers?.['x-idempotency-key'];
    const bodyId = rawPayload?.deliveryId ?? rawPayload?.requestId ?? rawPayload?.eventId;
    const id = headerId ?? bodyId;
    return typeof id === 'string' && id.length > 0 ? `webhook:${id}` : undefined;
  }

  formatOutbound(response: AdapterResponse): any {
    return { text: response.text, attachments: response.attachments };
  }

  /**
   * POST the reply to the gateway's callback URL.
   *
   * There is no platform behind this one: whatever the operator put at
   * `callback_url` answers, so HTTP is the whole contract and a
   * non-2xx is a refusal. The body is kept as text rather than parsed,
   * because a reverse proxy's 502 page is as likely as JSON.
   *
   * No configured URL is a refusal too. A webhook gateway with nowhere
   * to send the reply cannot answer anybody, and pretending otherwise is
   * what made a dropped reply look delivered. `testConnection` in
   * `channel-gateway.service` already treats the same state as
   * misconfigured, and nothing in the product has an inbound-only
   * webhook shape.
   *
   * `webhook_url` is accepted as well as `callback_url` because
   * `testConnection` accepts either for this gateway type. It did not
   * before, so a gateway configured with `webhook_url` passed its
   * connection test and then refused every send — the two paths
   * disagreeing about the same config key, which is the shape of bug
   * that produced the silently-dropped reply in the first place.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const target = config.callback_url || config.webhook_url;
    if (!target) {
      this.sendFailed('no callback_url or webhook_url is configured, so there is nowhere to send the reply');
    }
    const body = JSON.stringify(formattedResponse);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // HMAC signature for verification
    if (config.secret) {
      const signature = crypto.createHmac('sha256', config.secret).update(body).digest('hex');
      headers['X-Webhook-Signature'] = signature;
    }

    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(target, { method: 'POST', headers, body });

    if (this.httpRejected(res)) {
      const detail = await this.readTextBody(res);
      this.sendFailed(
        `the callback returned HTTP ${this.httpStatus(res)}${detail ? ` — ${detail}` : ''}`,
      );
    }
  }

  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
    // Fail closed: without a shared secret any caller could drive the
    // agent through this endpoint.
    if (!config.secret) return false;
    const signature = headers['x-webhook-signature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', config.secret).update(rawBody ?? JSON.stringify(payload)).digest('hex');
    // Length-check before timingSafeEqual, which throws on mismatched
    // buffer lengths.
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
