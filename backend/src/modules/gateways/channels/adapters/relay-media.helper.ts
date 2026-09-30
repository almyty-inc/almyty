/**
 * Media on the iMessage relays: the URLs a relay hands us for what someone
 * sent, and the URLs we hand a relay for what the agent sends back.
 *
 * Neither relay says what kind of file a URL is, so the kind is read off
 * the file extension, which both relays keep on their media links
 * (Sendblue requires it on outbound media). The real content type comes
 * from the response when the file is fetched (channel-attachments.service.ts).
 */

export interface ChannelAttachment {
  url: string;
  type: string;
  name: string;
}

const TYPES_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  caf: 'audio/x-caf',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  vcf: 'text/vcard',
};

/** An inbound media link as an attachment, or null when it is not an https URL. */
export function attachmentFromUrl(value: unknown): ChannelAttachment | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  let name = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape keeps the raw segment.
  }
  name = name || 'attachment';
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return { url: url.toString(), type: TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream', name };
}

/**
 * The URLs of a reply's attachments a relay can fetch: https only (both
 * relays refuse anything else), no longer than `maxLength` when the relay
 * caps it, at most `max` of them.
 */
export function outboundMediaUrls(
  attachments: Array<{ url?: string }> | null | undefined,
  max: number,
  maxLength = Infinity,
): string[] {
  if (!Array.isArray(attachments)) return [];
  const urls: string[] = [];
  for (const attachment of attachments) {
    const found = attachmentFromUrl(attachment?.url);
    if (!found || found.url.length > maxLength) continue;
    urls.push(found.url);
    if (urls.length >= max) break;
  }
  return urls;
}

/** The reply attachments whose links made it into `urls` (outboundMediaUrls), for the text that goes with them. */
export function sentAttachments<T extends { url?: string }>(attachments: T[] | null | undefined, urls: string[]): T[] {
  if (!Array.isArray(attachments) || !urls.length) return [];
  const sent = new Set(urls);
  return attachments.filter((a) => {
    const found = attachmentFromUrl(a?.url);
    return !!found && sent.has(found.url);
  });
}
