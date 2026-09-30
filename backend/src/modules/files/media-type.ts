/**
 * Upload media types and download headers, shared by the files route and
 * the storage backends.
 */

const TOKEN = "[a-z0-9!#$&^_.+-]";
const ESSENCE = new RegExp(`^${TOKEN}+/${TOKEN}+$`);
const PARAMETER = new RegExp(`^\\s*${TOKEN}+=(?:"[^"\\\\]*"|${TOKEN}+)\\s*$`, 'i');

/**
 * The `type/subtype` of a Content-Type, lower-cased, or null when the
 * value is not exactly one well-formed media type (parameters such as
 * `; charset=utf-8` are allowed and dropped).
 *
 * The allowlist used to compare by prefix, so `text/plain, text/html` or
 * `text/plain<anything>` passed as text/plain and was stored, and sent on
 * to object storage, as given.
 */
export function parseMediaType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const [essence, ...parameters] = value.split(';');
  const type = essence.trim().toLowerCase();
  if (!ESSENCE.test(type)) return null;
  if (!parameters.every((parameter) => PARAMETER.test(parameter))) return null;
  return type;
}

/** Exact media types a user may upload. */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/yaml',
  'application/x-yaml',
  'application/pdf',
  'application/zip',
  'application/msword',
  'application/vnd.ms-excel',
  // Generic, so non-web binary artifacts (zipped deps, models) can still
  // upload; downloads are always served as octet-stream with nosniff.
  'application/octet-stream',
]);

/** Office Open XML: one family, many subtypes (…wordprocessingml.document, …spreadsheetml.sheet). */
const OFFICE_OPEN_XML = 'application/vnd.openxmlformats-officedocument.';

/**
 * The upload's media type when it is on the allowlist, else null. Left
 * out on purpose: executables and shell scripts, `text/html` (stored XSS
 * if ever served inline), `image/svg+xml` (script inside), Java archives,
 * shared libraries and Android packages.
 */
export function allowedUploadType(value: unknown): string | null {
  const type = parseMediaType(value);
  if (!type) return null;
  if (ALLOWED_TYPES.has(type)) return type;
  return type.startsWith(OFFICE_OPEN_XML) && type.length > OFFICE_OPEN_XML.length ? type : null;
}

/**
 * `attachment` with the name escaped per RFC 6266: the plain `filename`
 * in a quoted string with `\`, `"`, line breaks and non-ASCII replaced
 * (a name like `foo.jpg"; Content-Type: text/html; x="` would otherwise
 * inject parameters), plus the UTF-8 name as `filename*`.
 */
export function attachmentDisposition(name: string): string {
  const fallback = (name || 'download').replace(/[\\"\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  // RFC 5987 wants ' ( ) percent-encoded as well, which encodeURIComponent leaves.
  const extra: Record<string, string> = { "'": '%27', '(': '%28', ')': '%29' };
  const utf8 = encodeURIComponent(name || 'download').replace(/['()]/g, (c) => extra[c]);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}

/**
 * The type the bytes themselves say, for the kinds a model can be shown
 * (PNG, JPEG, GIF, WebP, PDF), or null. A file someone sent on a channel
 * arrives with a name and a type chosen by whoever sent it; neither is
 * evidence of what the bytes are, and a model vendor refuses an image
 * whose declared type does not match its content.
 */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (bytes.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 3 && starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 6 && (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 5 && starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

/** The image types every vision-capable vendor here accepts. */
export const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
