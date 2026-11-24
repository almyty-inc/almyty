import { htmlToText, looksLikeMime, parseMimeMessage } from '../gateways/channels/adapters/mime.helper';
import { asJson, shortenForStore } from './checker-evidence';
import { STEP_PAYLOAD_CAP, withTruncationMarker } from './persist-cap';

/**
 * A tool result as a run's model reads it: readable, and no larger than
 * the step log keeps of it.
 *
 * Every tool result goes back to the model on every later call of the
 * run, so a result's size is paid for again on each of them. Results
 * reached the model whole while the step log kept 32 KB of each, and a
 * mail API returns a message as its MIME tree with every body base64
 * encoded, the HTML alternative next to the plain text and fifty
 * transport headers. Fourteen Gmail threads_get results, each holding
 * earlier HTML briefs, put ~393k tokens into each of the run's last two
 * calls ($2.31 against $0.73 the run before; run fedb735b).
 *
 * So, before the model sees a result:
 *  - a MIME part with an encoded body (`{mimeType, headers, body: {data}}`,
 *    Gmail's `format=full`) gets its body as text: HTML turned to text, an
 *    HTML alternative dropped when a plain-text one is there, a non-text
 *    body left out with its size; its headers are only the ones that say
 *    who, when and what;
 *  - a whole raw message (`{raw}` that decodes to RFC 5322 mail, Gmail's
 *    `format=raw`) is parsed into its sender, recipients, subject and text;
 *  - any other long run of base64 is left out, with its length;
 *  - what is still larger than STEP_PAYLOAD_CAP is shortened as the step
 *    log shortens it (persist-cap.ts): a JSON result item by item, still
 *    valid JSON, every item with its identifying fields and a note saying
 *    what was left out; text cut with the truncation marker.
 * A result that needs none of this is given exactly as it came.
 */
export const MODEL_TOOL_RESULT_CAP = STEP_PAYLOAD_CAP;

/** Headers of a mail part the model is given: who, when, what, and which thread. */
const KEPT_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'content-disposition']);

/**
 * A string this long made only of base64 characters, mixing upper case,
 * lower case and digits, is encoded data, not words.
 */
const ENCODED_MIN_CHARS = 1024;
const ENCODED = /^[A-Za-z0-9+/_-]+={0,2}$/;
const looksEncoded = (s: string) => ENCODED.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
const MAX_DEPTH = 40;

export function toolResultTextForModel(content: string, cap: number = MODEL_TOOL_RESULT_CAP): string {
  if (typeof content !== 'string' || !content) return content;
  const parsed = asJson(undefined, content);
  let text = content;
  let value: unknown = parsed;
  if (parsed !== undefined) {
    const state = { changed: false };
    value = readable(parsed, state, 0);
    if (state.changed) text = JSON.stringify(value);
  }
  if (text.length <= cap) return text;
  if (value !== undefined) {
    const shortened = shortenForStore(value, text, cap);
    if (shortened) return JSON.stringify(shortened);
  }
  return withTruncationMarker(text.slice(0, Math.max(0, cap - 100)), text.length);
}

type State = { changed: boolean };

function readable(value: unknown, state: State, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return encodedLeftOut(value, state);
  if (Array.isArray(value)) return value.map((v) => readable(v, state, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if (isMimePart(o)) return readablePart(o, state, depth);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'raw' && typeof v === 'string') {
      const mail = rawMail(v);
      if (mail) {
        state.changed = true;
        out.message = mail;
        continue;
      }
    }
    out[k] = readable(v, state, depth + 1);
  }
  return out;
}

function encodedLeftOut(s: string, state: State): string {
  if (s.length < ENCODED_MIN_CHARS || !looksEncoded(s)) return s;
  state.changed = true;
  return `[${s.length.toLocaleString('en-US')} characters of encoded data left out]`;
}

function isMimePart(o: Record<string, unknown>): boolean {
  if (typeof o.mimeType !== 'string') return false;
  const body = o.body as Record<string, unknown> | undefined;
  return (!!body && typeof body === 'object' && 'data' in body) || Array.isArray(o.parts) || Array.isArray(o.headers);
}

function readablePart(part: Record<string, unknown>, state: State, depth: number): Record<string, unknown> {
  const mimeType = String(part.mimeType).toLowerCase();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(part)) {
    if (k === 'headers' && Array.isArray(v)) {
      const kept = v.filter((h: any) => !(h && typeof h.name === 'string') || KEPT_HEADERS.has(h.name.toLowerCase()));
      if (kept.length !== v.length) state.changed = true;
      out.headers = kept;
    } else if (k === 'body' && v && typeof v === 'object' && typeof (v as any).data === 'string') {
      out.body = readableBody(v as Record<string, unknown>, mimeType, charsetOf(part.headers), state);
    } else if (k === 'parts' && Array.isArray(v)) {
      out.parts = alternatives(v, mimeType, state).map((p) => readable(p, state, depth + 1));
    } else {
      out[k] = readable(v, state, depth + 1);
    }
  }
  return out;
}

/** A multipart/alternative's parts, without the HTML one when a plain-text one says the same. */
function alternatives(parts: unknown[], mimeType: string, state: State): unknown[] {
  if (mimeType !== 'multipart/alternative') return parts;
  const typeOf = (p: any) => (p && typeof p.mimeType === 'string' ? p.mimeType.toLowerCase() : '');
  const plain = parts.some((p: any) => typeOf(p) === 'text/plain' && typeof p?.body?.data === 'string' && p.body.data.length > 0);
  if (!plain) return parts;
  const kept = parts.filter((p) => typeOf(p) !== 'text/html');
  if (kept.length !== parts.length) state.changed = true;
  return kept;
}

function readableBody(body: Record<string, unknown>, mimeType: string, charset: string, state: State): Record<string, unknown> {
  const { data, ...rest } = body as Record<string, unknown> & { data: string };
  state.changed = true;
  if (!mimeType.startsWith('text/')) {
    return { ...rest, data: `[${(Number(body.size) || Math.floor((data.length * 3) / 4)).toLocaleString('en-US')} bytes of ${mimeType} left out]` };
  }
  const decoded = decode(data, charset);
  return { ...rest, text: mimeType === 'text/html' ? htmlToText(decoded) : decoded.trim() };
}

function charsetOf(headers: unknown): string {
  if (!Array.isArray(headers)) return 'utf-8';
  const type = headers.find((h: any) => typeof h?.name === 'string' && h.name.toLowerCase() === 'content-type');
  const m = /charset="?([\w.:-]+)"?/i.exec(String((type as any)?.value ?? ''));
  return m ? m[1].toLowerCase() : 'utf-8';
}

function decode(data: string, charset: string): string {
  const bytes = Buffer.from(data, 'base64');
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** A raw RFC 5322 message, base64 encoded (Gmail's format=raw), as its parts a person reads; null when it is not one. */
function rawMail(raw: string): Record<string, unknown> | null {
  if (raw.length < 16 || !ENCODED.test(raw)) return null;
  const text = Buffer.from(raw, 'base64').toString('utf8');
  if (!looksLikeMime(text)) return null;
  const mail = parseMimeMessage(text);
  return {
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    text: mail.text,
    ...(mail.attachments.length ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })) } : {}),
  };
}
