import { createHmac } from 'crypto';
import { EventEmitter } from 'events';

import { WebhookAdapter } from '../webhook.adapter';
import { verifyWebhookSignature, webhookSignatureSettings, signatureCandidates } from '../webhook-signature.helper';
import { ChannelGatewayService } from '../../channel-gateway.service';
import { REQUIRED_CREDENTIALS, missingCredentials } from '../../../../agent-channels/channel-publish';
import { CHANNEL_CONNECTORS } from '../../../../connections/connector-catalog';

/**
 * The webhook channel used to need a callback URL and to accept only its
 * own signature scheme (hex HMAC-SHA256 of the body in X-Webhook-Signature),
 * so a service that only calls in, or signs another way, could not use it.
 * Now the reply address is optional and the signature scheme is the
 * channel's configuration. PagerDuty's v3 webhooks are the worked example
 * (X-PagerDuty-Signature: v1=<hex sha256>, comma-separated while rotating);
 * nothing in code knows about them.
 */
const SECRET = 'a-shared-secret-of-some-length';
const body = JSON.stringify({ event: { id: 'evt-1', event_type: 'incident.triggered' } });
const hmac = (alg: string, content: string, enc: 'hex' | 'base64' = 'hex', secret = SECRET) =>
  createHmac(alg, secret).update(content).digest(enc);

describe('webhook signature settings', () => {
  const adapter = new WebhookAdapter();

  it('keeps the default scheme: X-Webhook-Signature, hex HMAC-SHA256 of the body', async () => {
    await expect(adapter.verifyWebhook({}, { 'x-webhook-signature': hmac('sha256', body) }, { secret: SECRET }, body)).resolves.toBe(true);
    await expect(adapter.verifyWebhook({}, { 'x-other': hmac('sha256', body) }, { secret: SECRET }, body)).resolves.toBe(false);
  });

  it('verifies a v1= prefixed signature in a header of the channel\'s choosing (PagerDuty v3 as configured)', async () => {
    const config = { secret: SECRET, signature_header: 'X-PagerDuty-Signature', signature_prefix: 'v1=' };
    const headers = { 'x-pagerduty-signature': `v1=${hmac('sha256', body)}` };
    await expect(adapter.verifyWebhook({}, headers, config, body)).resolves.toBe(true);
    // While a secret rotates the header carries several; any one may match.
    const rotating = { 'x-pagerduty-signature': `v1=${hmac('sha256', body, 'hex', 'old-secret-old-secret')}, v1=${hmac('sha256', body)}` };
    await expect(adapter.verifyWebhook({}, rotating, config, body)).resolves.toBe(true);
    // The default header is not consulted once another is configured.
    await expect(adapter.verifyWebhook({}, { 'x-webhook-signature': hmac('sha256', body) }, config, body)).resolves.toBe(false);
    // A signature without the expected prefix does not count.
    await expect(adapter.verifyWebhook({}, { 'x-pagerduty-signature': hmac('sha256', body) }, config, body)).resolves.toBe(false);
  });

  it('signs a header and the body when told to, in base64 and another hash', async () => {
    const config = {
      secret: SECRET,
      signature_header: 'X-Signature',
      signature_algorithm: 'sha1',
      signature_encoding: 'base64',
      signed_content: '{header:X-Timestamp}.{body}',
    };
    const headers = { 'x-timestamp': '1700000000', 'x-signature': hmac('sha1', `1700000000.${body}`, 'base64') };
    await expect(adapter.verifyWebhook({}, headers, config, body)).resolves.toBe(true);
    // The signed header missing: refused, not verified against an empty value.
    await expect(adapter.verifyWebhook({}, { 'x-signature': hmac('sha1', `.${body}`, 'base64') }, config, body)).resolves.toBe(false);
  });

  it('fails closed on settings it cannot honour, and without a secret', () => {
    const headers = { 'x-webhook-signature': hmac('sha256', body) };
    expect(verifyWebhookSignature({ secret: SECRET, signature_algorithm: 'md5' }, headers, body)).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, signature_header: 'Bad Header' }, headers, body)).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, signed_content: '{header:X-Timestamp}' }, headers, body)).toBe(false);
    expect(verifyWebhookSignature({}, headers, body)).toBe(false);
    expect(() => webhookSignatureSettings({ signature_encoding: 'binary' })).toThrow(/signature_encoding/);
    expect(signatureCandidates('v1=a, v0=b ,v1=c', 'v1=')).toEqual(['a', 'c']);
  });

  it('offers the settings on the channel form, spelled as the adapter reads them', () => {
    const connector = CHANNEL_CONNECTORS.find((c) => c.key === 'channel-webhook')!;
    const schema = connector.connect[0].schema!;
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['secret', 'callback_url', 'signature_header', 'signature_algorithm', 'signature_encoding', 'signature_prefix', 'signed_content']),
    );
    expect(schema.required).toEqual(['secret']);
  });
});

describe('inbound-only webhook channel', () => {
  it('publishes without a callback URL', () => {
    expect(REQUIRED_CREDENTIALS.webhook).toEqual(['secret']);
    expect(missingCredentials('webhook', { secret: SECRET })).toEqual([]);
  });

  it('says it sends no replies without a reply address', () => {
    const adapter = new WebhookAdapter();
    expect(adapter.repliesTo({ secret: SECRET })).toBe(false);
    expect(adapter.repliesTo({ secret: SECRET, callback_url: 'https://example.com/hook' })).toBe(true);
  });

  function service(emitter: EventEmitter, webhook: WebhookAdapter) {
    const runRepository = { findOne: jest.fn(async () => ({ id: 'run-1', output: 'Acknowledged the incident.', metadata: {} })), save: jest.fn() };
    const events: any[] = [];
    const eventRepository = { create: (d: any) => d, save: jest.fn(async (e: any) => events.push(e)), update: jest.fn(async () => ({ affected: 1 })) };
    const agentRuntime = { getRunEmitter: () => emitter };
    const args: any[] = new Array(27).fill(undefined);
    args[0] = {};
    args[1] = runRepository;
    args[2] = eventRepository;
    args[3] = agentRuntime;
    for (let i = 4; i <= 19; i++) args[i] = { type: `stub-${i}` };
    args[12] = webhook;
    const svc = new (ChannelGatewayService as any)(...args) as ChannelGatewayService;
    return { svc, events };
  }

  const gateway = (configuration: Record<string, any>) =>
    ({ id: 'gw-1', organizationId: 'org-1', type: 'webhook', configuration }) as any;

  async function finishRun(configuration: Record<string, any>) {
    const emitter = new EventEmitter();
    const webhook = new WebhookAdapter();
    const send = jest.spyOn(webhook, 'sendResponse').mockResolvedValue(undefined);
    const { svc, events } = service(emitter, webhook);
    const marked = jest.spyOn(svc as any, 'markInboundOutcome').mockResolvedValue(undefined);
    (svc as any).listenForCompletionAndRespond('run-1', gateway(configuration), webhook, { text: 'hi', userId: 'webhook' }, undefined, { id: 'evt-in' });
    emitter.emit('event', { type: 'run.completed' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { send, marked, events };
  }

  it('finishes the delivery without sending anything when there is no reply address', async () => {
    const { send, marked, events } = await finishRun({ secret: SECRET });
    expect(send).not.toHaveBeenCalled();
    expect(marked).toHaveBeenCalledWith({ id: 'evt-in' }, { status: 'processed', runId: 'run-1' });
    expect(events.filter((e) => e.direction === 'outbound')).toEqual([]);
  });

  it('still posts the reply when a reply address is set', async () => {
    const { send } = await finishRun({ secret: SECRET, callback_url: 'https://example.com/hook' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
