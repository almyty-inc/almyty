import type { AdapterResponse, OutboundAttachment } from './adapters/base.adapter';
import { attachmentFromUrl } from './adapters/relay-media.helper';

/** The most files one reply sends as media. */
export const MAX_REPLY_MEDIA = 10;

/**
 * The images and files a reply links to, found in its text.
 *
 * An agent answers in text, and when it has a picture or a document to
 * give it writes a link: `![a chart](https://.../chart.png)`, a link whose
 * target is a file (`[the invoice](https://.../invoice.pdf)`), or a bare
 * https URL ending in a file's extension. Those are sent as media on the
 * channels that can send media; the rest keep the text as written.
 *
 * Only https links whose path names a known file type count
 * (relay-media.helper.ts); a page link stays a link. The platform fetches
 * the file itself, from the link, so nothing here downloads anything.
 *
 * `textWithoutMedia` is the text with each markdown image taken out and
 * each markdown file link reduced to its label, for an adapter that sends
 * the files as media; a bare URL stays where it is, since taking it out of
 * a sentence would leave the sentence broken.
 */
export function extractReplyMedia(text: string, max = MAX_REPLY_MEDIA): { attachments: OutboundAttachment[]; textWithoutMedia: string } {
  const attachments: OutboundAttachment[] = [];
  const seen = new Set<string>();
  const add = (url: string, label?: string): boolean => {
    const found = attachmentFromUrl(url);
    if (!found || found.type === 'application/octet-stream') return false;
    if (!seen.has(found.url) && attachments.length < max) {
      seen.add(found.url);
      attachments.push({ url: found.url, type: found.type, name: label?.trim() || found.name });
    }
    return true;
  };

  let stripped = String(text ?? '')
    // ![alt](url "title"): an image. Out of the text when sent as media.
    // Every part is bounded, so a reply full of brackets cannot make this slow.
    .replace(/!\[([^\]\n]{0,300})\]\([ \t]{0,8}<?(https:\/\/[^\s)>]{1,2048})>?(?:[ \t]{1,8}"[^"\n]{0,300}")?[ \t]{0,8}\)/gi, (whole, alt: string, url: string) =>
      add(url, alt) ? '' : whole,
    )
    // [label](url): a file link keeps its label.
    .replace(/\[([^\]\n]{1,300})\]\([ \t]{0,8}<?(https:\/\/[^\s)>]{1,2048})>?(?:[ \t]{1,8}"[^"\n]{0,300}")?[ \t]{0,8}\)/gi, (whole, label: string, url: string) =>
      add(url, label) ? label : whole,
    );

  // A bare URL: sent too, left in the text. Trailing punctuation is the
  // sentence's, not the link's.
  for (const match of stripped.matchAll(/(^|[\s(])(https:\/\/[^\s<>()]{1,2048})/gi)) {
    let url = match[2];
    while (url && '.,;:!?'.includes(url[url.length - 1])) url = url.slice(0, -1);
    add(url);
  }

  // Tidy what a removed image leaves: a double space inside a line (never
  // leading indentation, which a code block needs), trailing spaces, and
  // runs of blank lines.
  stripped = stripped
    .replace(/(\S) {2,}(?=\S)/g, '$1 ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { attachments, textWithoutMedia: stripped };
}

/**
 * The files a reply sends: what the run handed back as `attachments`, then
 * what its text links to, without repeats.
 */
export function replyMedia(
  fromOutput: OutboundAttachment[] | undefined,
  fromText: OutboundAttachment[],
  max = MAX_REPLY_MEDIA,
): OutboundAttachment[] | undefined {
  const out: OutboundAttachment[] = [];
  const seen = new Set<string>();
  for (const a of [...(fromOutput ?? []), ...fromText]) {
    if (!a?.url || seen.has(a.url)) continue;
    seen.add(a.url);
    out.push(a);
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

/**
 * The text an adapter sends with the media it sends.
 *
 * Nothing sent as media: the text as written. Some sent: the text with the
 * media links taken out, plus a line with the link of each file this
 * platform could not send as media, so no file the agent gave is lost.
 */
export function textWithMedia(response: AdapterResponse, sent: OutboundAttachment[]): string {
  if (!sent.length || response.textWithoutMedia === undefined) return response.text;
  const sentUrls = new Set(sent.map((a) => a.url));
  const rest = (response.attachments ?? []).filter((a) => !sentUrls.has(a.url));
  const lines = rest.map((a) => (a.name && a.name !== a.url ? `${a.name}: ${a.url}` : a.url));
  // A link still standing in the text is not repeated.
  const kept = lines.filter((line, i) => !response.textWithoutMedia!.includes(rest[i].url));
  return [response.textWithoutMedia, ...kept].filter(Boolean).join('\n');
}

/** Whether an attachment is an image the platforms render inline (not a PDF or other file). */
export function isImage(attachment: OutboundAttachment): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(attachment.type);
}
