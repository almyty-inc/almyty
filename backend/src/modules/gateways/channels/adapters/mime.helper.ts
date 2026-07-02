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
 */

export interface ParsedMimeMessage {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  /** Plain-text body (derived from text/html when no text/plain part). */
  text: string;
  /** Raw HTML body, when the message carried one. */
  html?: string;
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
  const { text, html } = extractBody(headers, body);
  return {
    from: headers['from'] ? decodeEncodedWords(headers['from']) : undefined,
    to: headers['to'] ? decodeEncodedWords(headers['to']) : undefined,
    subject: headers['subject'] ? decodeEncodedWords(headers['subject']) : undefined,
    messageId: headers['message-id']?.trim() || undefined,
    inReplyTo: headers['in-reply-to']?.trim() || undefined,
    text: (text || (html ? htmlToText(html) : '')).trim(),
    html,
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

function parseContentType(value: string | undefined): {
  mimeType: string;
  boundary?: string;
  charset?: string;
} {
  if (!value) return { mimeType: 'text/plain' };
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
  return {
    mimeType: typePart.trim().toLowerCase() || 'text/plain',
    boundary: params['boundary'],
    charset: params['charset'],
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
 * text/plain and first text/html bodies found.
 */
function extractBody(
  headers: Record<string, string>,
  body: string,
): { text?: string; html?: string } {
  const ct = parseContentType(headers['content-type']);

  if (ct.mimeType.startsWith('multipart/') && ct.boundary) {
    let text: string | undefined;
    let html: string | undefined;
    for (const rawPart of splitMultipart(body, ct.boundary)) {
      const part = splitHeadersBody(rawPart);
      const found = extractBody(part.headers, part.body);
      if (!text && found.text) text = found.text;
      if (!html && found.html) html = found.html;
      if (text && html) break;
    }
    return { text, html };
  }

  const decoded = decodeBody(body, headers['content-transfer-encoding'], ct.charset);
  if (ct.mimeType === 'text/html') return { html: decoded };
  if (ct.mimeType === 'text/plain' || ct.mimeType === 'text') return { text: decoded };
  // Non-text leaf (attachment, image, etc.) — ignored for normalization.
  return {};
}
