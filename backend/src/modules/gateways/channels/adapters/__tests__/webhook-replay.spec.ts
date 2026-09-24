import * as crypto from 'crypto';

import { WebhookAdapter } from '../webhook.adapter';

/**
 * The generic webhook's dedup key must come from what the signature
 * covers.
 *
 * X-Webhook-Signature is an HMAC of the raw body and nothing else, and
 * `deliveryId` preferred the X-Delivery-Id / X-Request-Id /
 * X-Idempotency-Key headers over the body's own id. Anyone holding one
 * captured, correctly signed request could resend it with a fresh
 * header: the signature still verified, the claim saw a new delivery id,
 * and the agent ran again -- as many times as they liked.
 */
describe('generic webhook replay', () => {
  const secret = 'shared-secret';
  const raw = JSON.stringify({ text: 'refund order 42', deliveryId: 'evt-1' });
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const adapter = new WebhookAdapter();

  it('a replay with a new delivery header still verifies (the header is not signed)', async () => {
    const headers = { 'x-webhook-signature': signature, 'x-delivery-id': 'fresh-123' };
    await expect(adapter.verifyWebhook(JSON.parse(raw), headers, { secret }, raw)).resolves.toBe(true);
  });

  it('keys it by the signed body id, so the replay collides with the original', () => {
    const original = adapter.deliveryId(JSON.parse(raw), { 'x-delivery-id': 'orig-1' });
    const replay = adapter.deliveryId(JSON.parse(raw), { 'x-delivery-id': 'fresh-123' });
    const noHeader = adapter.deliveryId(JSON.parse(raw), {});
    expect(original).toBe('webhook:evt-1');
    expect(replay).toBe(original);
    expect(noHeader).toBe(original);
  });

  it('still uses a sender header when the body carries no id', () => {
    expect(adapter.deliveryId({ text: 'hi' }, { 'x-delivery-id': 'h-1' })).toBe('webhook:h-1');
  });
});
