import type { InboundAttachment } from './base.adapter';

/** Where Twilio serves an inbound message's media; only this host is sent the account's credentials. */
export const TWILIO_MEDIA_HOSTS = ['api.twilio.com'];

/** Twilio forwards at most ten media items per message. */
const MAX_TWILIO_MEDIA = 10;

/**
 * The media an inbound Twilio message (SMS/MMS or WhatsApp) carries:
 * `NumMedia`, then `MediaUrl{i}` and `MediaContentType{i}` per item. The
 * URL is on api.twilio.com and, when the account requires authentication
 * for media, is read with the account SID and auth token; Twilio then
 * redirects to its CDN, and the credentials do not follow a redirect that
 * leaves the origin (safe-fetch.ts).
 */
export function twilioInboundMedia(payload: any): InboundAttachment[] {
  const count = Math.min(Number(payload?.NumMedia) || 0, MAX_TWILIO_MEDIA);
  const out: InboundAttachment[] = [];
  for (let i = 0; i < count; i++) {
    const url = payload?.[`MediaUrl${i}`];
    if (typeof url !== 'string' || !url) continue;
    const type = typeof payload?.[`MediaContentType${i}`] === 'string' ? payload[`MediaContentType${i}`] : 'application/octet-stream';
    const extension = type.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    out.push({ url, type, name: `media-${i + 1}${extension ? `.${extension}` : ''}` });
  }
  return out;
}

/** The Basic credentials a Twilio API call (or media read) goes with, or null when unconfigured. */
export function twilioAuthHeader(config: Record<string, any>): string | null {
  if (!config?.twilio_account_sid || !config?.twilio_auth_token) return null;
  return `Basic ${Buffer.from(`${config.twilio_account_sid}:${config.twilio_auth_token}`).toString('base64')}`;
}
