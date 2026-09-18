/**
 * Twilio's Messages API verdict, shared by the two Twilio-backed
 * adapters (sms and whatsapp).
 *
 * A created message answers 201 with
 * `{sid: "SM...", status: "queued", error_code: null, ...}`. A refusal
 * answers 4xx with `{code, message, more_info, status}` — 21211 for a
 * `To` number Twilio will not parse, 21610 once a recipient has opted
 * out, 20003 on bad credentials, 63016 for a WhatsApp message outside
 * the 24-hour session window. So the HTTP status is the verdict and
 * `message`/`code` are the wording worth keeping; `error_code` on an
 * otherwise-accepted create is checked too, because Twilio uses it to
 * report a message it took but will not deliver.
 *
 * Returns null when Twilio accepted the message, or the reason it did
 * not. Nothing from the request — no account sid, no auth token — ever
 * reaches the returned string.
 */
export function twilioSendFailure(
  status: number | undefined,
  rejected: boolean,
  body: any,
): string | null {
  const shown = typeof status === 'number' ? String(status) : '?';
  if (rejected) {
    const detail = body?.message ?? body?.error_message ?? `HTTP ${shown}`;
    const code = body?.code ?? body?.error_code;
    return `Twilio refused the reply: ${detail}${code ? ` (code ${code})` : ''}`;
  }
  if (body?.error_code) {
    const detail = body?.error_message ?? 'no message given';
    return `Twilio accepted then failed the reply: ${detail} (code ${body.error_code})`;
  }
  return null;
}
