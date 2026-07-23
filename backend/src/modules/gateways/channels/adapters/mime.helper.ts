/**
 * Minimal, dependency-free MIME parser for inbound email webhooks.
 *
 * Deliberately hand-rolled instead of pulling in `mailparser`: the
 * adapter contract (`normalizeInbound`) is synchronous while mailparser
 * is async/stream-based, we only need headers + a plain-text body for
 * channel normalization (attachments are ignored), and mailparser drags
 * in a large transitive dependency tree for that small slice.
 *
 * Supported:
 *   - header unfolding (RFC 5322 continuation lines)
 *   - RFC 2047 encoded-words (=?charset?B|Q?...?=) in From/To/Subject
 *   - Content-Transfer-Encoding: base64, quoted-printable, 7bit/8bit
 *   - nested multipart/* (alternative, mixed, related) via boundary
 *     splitting, recursive; first text/plain wins, text/html fallback
 *   - charset decoding via TextDecoder (utf-8 default; latin1 etc.)
 *   - HTML-to-text stripping when no text/plain part exists
 *   - attachment metadata (filename, content type, decoded byte size,
 *     content-id) collected from non-text leaves and any part carrying
 *     `Content-Disposition: attachment`; the bytes themselves are not
 *     retained (channel normalization only needs the metadata).
 */

/** Metadata for a single inbound attachment (bytes intentionally omitted). */
export interface ParsedMimeAttachment {
  /** Filename from Content-Disposition or the Content-Type `name` param. */
  filename?: string;
  /** MIME type of the part, e.g. `application/pdf`. */
  contentType: string;
  /** Decoded size in bytes. */
  size: number;
  /** Content-ID (without angle brackets), for inline/related parts. */
  contentId?: string;
  /** Content-Disposition value: `attachment`, `inline`, or undefined. */
  disposition?: string;
}

export interface ParsedMimeMessage {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  /** Raw References header: whitespace-separated message-ids, thread root first. */
  references?: string;
  /** Plain-text body (derived from text/html when no text/plain part). */
  text: string;
  /** Raw HTML body, when the message carried one. */
  html?: string;
  /** Metadata for every attachment part found (empty when none). */
  attachments: ParsedMimeAttachment[];
}

/** Cheap sniff: does this string start with an RFC 5322 header block? */
export function looksLikeMime(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] || '';
  return /^(from|to|subject|date|received|mime-version|content-type|message-id|return-path|delivered-to):/im.test(
    headerBlock,
  );
}

/** Parse a raw RFC 5322 / MIME message into normalized fields. */
export function parseMimeMessage(raw: string): ParsedMimeMessage {
  const { headers, body } = splitHeadersBody(raw);
  const attachments: ParsedMimeAttachment[] = [];
  const { text, html } = extractBody(headers, body, attachments);
  return {
    from: headers['from'] ? decodeEncodedWords(headers['from']) : undefined,
    to: headers['to'] ? decodeEncodedWords(headers['to']) : undefined,
    subject: headers['subject'] ? decodeEncodedWords(headers['subject']) : undefined,
    messageId: headers['message-id']?.trim() || undefined,
    inReplyTo: headers['in-reply-to']?.trim() || undefined,
    references: headers['references']?.trim() || undefined,
    text: (text || (html ? htmlToText(html) : '')).trim(),
    html,
    attachments,
  };
}

/** Strip an HTML body down to readable plain text. */
export function htmlToText(html: string): string {
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

function splitHeadersBody(raw: string): { headers: Record<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const headerBlock = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : '';

  const headers: Record<string, string> = {};
  const lines = headerBlock.split(/\r?\n/);
  let currentName: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentName) {
      // Unfold: continuation of the previous header
      headers[currentName] += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) {
      currentName = null;
      continue;
    }
    currentName = line.slice(0, idx).trim().toLowerCase();
    headers[currentName] = line.slice(idx + 1).trim();
  }
  return { headers, body };
}

/** Split a header value like `type; a=b; c="d"` into its type and params. */
function parseHeaderParams(value: string | undefined): {
  value: string;
  params: Record<string, string>;
} {
  if (!value) return { value: '', params: {} };
  const [typePart, ...paramParts] = value.split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[name] = val;
  }
  return { value: typePart.trim(), params };
}

function parseContentType(value: string | undefined): {
  mimeType: string;
  boundary?: string;
  charset?: string;
  name?: string;
} {
  if (!value) return { mimeType: 'text/plain' };
  const { value: typePart, params } = parseHeaderParams(value);
  return {
    mimeType: typePart.toLowerCase() || 'text/plain',
    boundary: params['boundary'],
    charset: params['charset'],
    name: params['name'] ? decodeEncodedWords(params['name']) : undefined,
  };
}

function parseContentDisposition(value: string | undefined): {
  disposition?: string;
  filename?: string;
} {
  if (!value) return {};
  const { value: dispPart, params } = parseHeaderParams(value);
  const filename = params['filename'] || params["filename*"];
  return {
    disposition: dispPart.toLowerCase() || undefined,
    filename: filename ? decodeEncodedWords(filename) : undefined,
  };
}

function decodeCharset(buf: Buffer, charset?: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

function decodeQuotedPrintable(input: string): Buffer {
  // Soft line breaks first
  const cleaned = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(ch, 'utf-8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, transferEncoding: string | undefined, charset?: string): string {
  const enc = (transferEncoding || '').trim().toLowerCase();
  let decoded: string;
  if (enc === 'base64') {
    decoded = decodeCharset(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
  } else if (enc === 'quoted-printable') {
    decoded = decodeCharset(decodeQuotedPrintable(body), charset);
  } else {
    // 7bit / 8bit / binary / absent: the JSON transport already
    // delivered this as a JS string, so use it as-is.
    decoded = body;
  }
  // Normalize CRLF so downstream consumers see plain \n line endings.
  return decoded.replace(/\r\n/g, '\n');
}

/** RFC 2047 encoded-word decoding for header values. */
function decodeEncodedWords(value: string): string {
  return value
    // Whitespace between two adjacent encoded words is not significant
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      try {
        if (enc.toLowerCase() === 'b') {
          return decodeCharset(Buffer.from(data, 'base64'), charset);
        }
        // Q-encoding: underscore = space, =XX hex bytes
        const qp = decodeQuotedPrintable(String(data).replace(/_/g, ' '));
        return decodeCharset(qp, charset);
      } catch {
        return data;
      }
    })
    .trim();
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const closing = `${marker}--`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === closing) {
      if (current) parts.push(current.join('\n'));
      current = null;
      break;
    }
    if (trimmed === marker) {
      if (current) parts.push(current.join('\n'));
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current && current.length) parts.push(current.join('\n'));
  return parts;
}

/**
 * Walk a (possibly nested multipart) entity and pull out the first
 * text/plain and first text/html bodies found. Any non-body leaf (or a
 * part explicitly marked `Content-Disposition: attachment`) has its
 * metadata pushed onto `attachments`.
 */
function extractBody(
  headers: Record<string, string>,
  body: string,
  attachments: ParsedMimeAttachment[] = [],
): { text?: string; html?: string } {
  const ct = parseContentType(headers['content-type']);

  if (ct.mimeType.startsWith('multipart/') && ct.boundary) {
    let text: string | undefined;
    let html: string | undefined;
    for (const rawPart of splitMultipart(body, ct.boundary)) {
      const part = splitHeadersBody(rawPart);
      const found = extractBody(part.headers, part.body, attachments);
      if (!text && found.text) text = found.text;
      if (!html && found.html) html = found.html;
    }
    return { text, html };
  }

  const disp = parseContentDisposition(headers['content-disposition']);
  const decoded = decodeBody(body, headers['content-transfer-encoding'], ct.charset);

  // A text leaf is body content unless it is explicitly an attachment.
  const isTextBody =
    (ct.mimeType === 'text/html' || ct.mimeType === 'text/plain' || ct.mimeType === 'text') &&
    disp.disposition !== 'attachment';
  if (isTextBody) {
    return ct.mimeType === 'text/html' ? { html: decoded } : { text: decoded };
  }

  // Everything else is an attachment (or inline non-text): record its
  // metadata. The decoded byte length gives an accurate size even when
  // the part arrived base64/quoted-printable encoded.
  attachments.push({
    filename: disp.filename || ct.name,
    contentType: ct.mimeType || 'application/octet-stream',
    size: decodedByteLength(body, headers['content-transfer-encoding']),
    contentId: normalizeContentId(headers['content-id']),
    disposition: disp.disposition,
  });
  return {};
}

/** Byte length of a part's decoded content, without materializing text. */
function decodedByteLength(body: string, transferEncoding: string | undefined): number {
  const enc = (transferEncoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').length;
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body).length;
  }
  return Buffer.byteLength(body, 'utf-8');
}

/** Strip the surrounding angle brackets from a Content-ID header. */
function normalizeContentId(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  return v.replace(/^<|>$/g, '') || undefined;
}
