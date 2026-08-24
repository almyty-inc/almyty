import * as crypto from 'crypto';

/**
 * Validate Twilio's X-Twilio-Signature header: base64(HMAC-SHA1(auth
 * token, exact public webhook URL + POST params sorted alphabetically
 * by key, each appended as key+value)). See
 * https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Shared by the whatsapp (Twilio) and sms (Twilio) adapters — both
 * receive the same application/x-www-form-urlencoded webhook shape.
 *
 * Verification is REQUIRED. Both twilio_auth_token and webhook_url (the
 * exact URL configured in the Twilio console, needed because Twilio
 * signs the full URL and we sit behind a proxy) must be present.
 * Without them the signed URL cannot be reconstructed, so the request
 * is refused. This previously returned true in that case, which meant
 * any gateway whose webhook_url was never backfilled accepted any POST.
 */
export function verifyTwilioSignature(
  payload: any,
  headers: Record<string, string>,
  config: Record<string, any>,
): boolean {
  const authToken = config.twilio_auth_token;
  const url = config.webhook_url;
  if (!authToken || !url) return false;

  const signature = headers['x-twilio-signature'];
  if (!signature) return false;

  const params = payload && typeof payload === 'object' ? payload : {};
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + String(params[key] ?? ''), String(url));
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf-8').digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
