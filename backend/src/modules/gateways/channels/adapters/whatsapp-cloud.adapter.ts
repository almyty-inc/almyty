import { Injectable, Logger } from '@nestjs/common';
import {
  BaseAdapter,
  NormalizedMessage,
  AdapterResponse,
  AttachmentFetchLimits,
  FetchedAttachment,
  InboundAttachment,
  OutboundAttachment,
} from './base.adapter';
import { textWithMedia } from '../reply-media';
import { ResponseTooLargeError, safeFetch } from '../../../../common/security/safe-fetch';
import * as crypto from 'crypto';

/**
 * WhatsApp via Meta's Cloud API (direct, no Twilio in between).
 *
 * Configuration:
 *   - access_token     Meta system-user / app token used for outbound
 *   - phone_number_id  the Cloud API phone number id (not the E.164)
 *   - verify_token     shared secret echoed during Meta's GET webhook
 *                      verification handshake (hub.challenge)
 *   - app_secret       app secret used to verify X-Hub-Signature-256
 *                      on inbound POSTs (HMAC-SHA256 over the raw body)
 *
 * Inbound shape (POST): entry[].changes[].value.messages[] — text
 * messages carry text.body, image and document messages a media id and
 * a caption; `from` is the sender's E.164 (no prefix)
 * and doubles as the conversation thread key.
 *
 * Outbound: POST graph.facebook.com/<ver>/<phone_number_id>/messages
 * with { messaging_product: "whatsapp", to, text: { body } }.
 *
 * The GET verification handshake (hub.mode=subscribe) is handled in
 * the unified delegation layer, which calls handleVerification().
 */
@Injectable()
export class WhatsAppCloudAdapter extends BaseAdapter {
  private readonly logger = new Logger(WhatsAppCloudAdapter.name);
  readonly type = 'whatsapp_cloud';

  static readonly GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';
  /** Where Meta serves media bytes; only this host is sent the access token. */
  static readonly MEDIA_HOSTS = ['lookaside.fbsbx.com'];
  /** The most media one reply sends; each is a message of its own. */
  static readonly MAX_MEDIA = 5;

  normalizeInbound(rawPayload: any): NormalizedMessage {
    const value = rawPayload?.entry?.[0]?.changes?.[0]?.value ?? {};
    const message = value?.messages?.[0] ?? {};
    const contact = value?.contacts?.[0];
    // An image or a document arrives as a media id, with its caption as the text.
    const media = message?.type === 'image' ? message.image : message?.type === 'document' ? message.document : null;
    const attachments: InboundAttachment[] = media?.id
      ? [{
          ref: String(media.id),
          type: media.mime_type || 'application/octet-stream',
          name: media.filename || (message.type === 'image' ? 'image.jpg' : 'document'),
        }]
      : [];
    return {
      text: message?.text?.body || media?.caption || '',
      userId: message?.from || 'unknown',
      threadId: message?.from, // sender E.164 is the conversation key
      ...(attachments.length ? { attachments } : {}),
      metadata: {
        from: message?.from,
        messageId: message?.id,
        phoneNumberId: value?.metadata?.phone_number_id,
        profileName: contact?.profile?.name,
        source: 'whatsapp_cloud',
      },
    };
  }

  /**
   * A media id becomes bytes in two Graph calls, both with the access
   * token: the media's own node names a short-lived URL, and the URL is
   * read. The URL comes from Meta's answer, and the token goes with it only
   * when it is on Meta's media host.
   */
  async fetchAttachment(
    attachment: InboundAttachment,
    config: Record<string, any>,
    limits: AttachmentFetchLimits,
  ): Promise<FetchedAttachment | null> {
    if (!attachment.ref || !config.access_token || !/^[A-Za-z0-9_-]+$/.test(attachment.ref)) return null;
    const auth = { Authorization: `Bearer ${config.access_token}` };
    const res = await safeFetch(`${WhatsAppCloudAdapter.GRAPH_API_BASE}/${attachment.ref}`, {
      method: 'GET',
      headers: auth,
      maxBytes: 64 * 1024,
      timeoutMs: limits.timeoutMs,
    });
    const node = await this.readJsonBody(res);
    if (typeof node?.file_size === 'number' && node.file_size > limits.maxBytes) throw new ResponseTooLargeError(limits.maxBytes);
    if (!BaseAdapter.onHost(node?.url, WhatsAppCloudAdapter.MEDIA_HOSTS)) throw new Error('the media node named no file on the media host');
    return this.fetchBytes(node.url, limits, auth);
  }

  /** The `wamid.` message id Meta assigns, stable across redelivery. */
  deliveryId(rawPayload: any): string | undefined {
    const id = rawPayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
    return id ? `whatsapp_cloud:${id}` : undefined;
  }

  /**
   * Media the Cloud API sends by link: a JPEG or PNG as an image, a PDF as
   * a document. Anything else stays a link in the text.
   */
  formatOutbound(response: AdapterResponse): any {
    const media: Array<Record<string, unknown>> = [];
    const sent: OutboundAttachment[] = [];
    for (const a of response.attachments ?? []) {
      if (media.length >= WhatsAppCloudAdapter.MAX_MEDIA) break;
      if (a.type === 'image/jpeg' || a.type === 'image/png') {
        media.push({ type: 'image', image: { link: a.url } });
      } else if (a.type === 'application/pdf') {
        media.push({ type: 'document', document: { link: a.url, filename: a.name } });
      } else {
        continue;
      }
      sent.push(a);
    }
    const body = textWithMedia(response, sent);
    return media.length ? { body, media } : { body };
  }

  /**
   * Send through the Cloud API: the text, then one message per file.
   *
   * The Graph API is HTTP-shaped: 200 with
   * `{messaging_product, contacts, messages: [{id: "wamid..."}]}` on
   * success, and a 4xx carrying `{error: {message, type, code,
   * error_subcode, fbtrace_id}}` on failure — code 131030 for a
   * recipient not on the allow-list of an unverified number, 190 for an
   * expired access token, 131047 once the 24-hour customer-service
   * window has closed and a template is required. So the status is the
   * verdict, `error.message` is the wording to keep, and `fbtrace_id`
   * is what Meta support asks for.
   */
  async sendResponse(config: Record<string, any>, formattedResponse: any, threadContext?: any): Promise<void> {
    const to = threadContext?.from || threadContext?.threadId;
    const media: Array<Record<string, unknown>> = Array.isArray(formattedResponse.media) ? formattedResponse.media : [];
    if (formattedResponse.body || !media.length) {
      await this.send(config, { messaging_product: 'whatsapp', to, text: { body: formattedResponse.body } });
    }
    for (const item of media) await this.send(config, { messaging_product: 'whatsapp', to, ...item });
  }

  private async send(config: Record<string, any>, message: Record<string, unknown>): Promise<void> {
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await (fetch as any)(
      `${WhatsAppCloudAdapter.GRAPH_API_BASE}/${config.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      },
    );

    const body = await this.readJsonBody(res);
    const error = body?.error;
    if (this.httpRejected(res) || error) {
      const detail = error?.message ?? `HTTP ${this.httpStatus(res)}`;
      const code = error?.code !== undefined ? ` (code ${error.code}${error?.error_subcode ? `/${error.error_subcode}` : ''})` : '';
      const trace = error?.fbtrace_id ? ` [fbtrace ${error.fbtrace_id}]` : '';
      this.sendFailed(`the Cloud API refused the reply: ${detail}${code}${trace}`);
    }
  }

  /**
   * Meta signs every webhook POST with X-Hub-Signature-256:
   * `sha256=` + hex(HMAC-SHA256(app_secret, raw body bytes)).
   *
   * Fails closed. Meta always signs, so an unconfigured app_secret is a
   * misconfiguration rather than a reason to trust the payload — this
   * comment used to say the check was "skipped otherwise", which was a
   * description of behaviour that no longer exists and an invitation to
   * put it back.
   */
  async verifyWebhook(payload: any, headers: Record<string, string>, config: Record<string, any>, rawBody?: string): Promise<boolean> {
    const appSecret = config.app_secret;
    // Fail closed: Meta always signs inbound with the app secret, so a
    // missing app_secret is a misconfiguration, not a reason to trust.
    if (!appSecret) return false;

    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;

    const raw = rawBody ?? JSON.stringify(payload ?? {});
    const expected =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(raw, 'utf-8').digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Meta webhook verification handshake (GET with hub.* query params):
   * echo hub.challenge iff hub.mode is "subscribe" and hub.verify_token
   * matches the configured verify_token. Returns the challenge string
   * to echo, or null when verification fails.
   *
   * The token comparison is constant-time. This endpoint is reachable
   * unauthenticated with unlimited attempts and the caller supplies one
   * side of the comparison, so it gets the same treatment as every
   * other secret compare in this module rather than a plain inequality.
   */
  static handleVerification(
    query: Record<string, any>,
    config: Record<string, any>,
  ): string | null {
    const mode = query?.['hub.mode'];
    const token = query?.['hub.verify_token'];
    const challenge = query?.['hub.challenge'];
    if (mode !== 'subscribe') return null;
    if (!config?.verify_token) return null;
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(String(config.verify_token));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return String(challenge ?? '');
  }
}
