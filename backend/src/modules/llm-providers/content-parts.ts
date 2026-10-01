import type { MessageContent } from '../../entities/message.entity';

/**
 * Message content in each vendor's wire shape.
 *
 * A message's content is a string or a list of parts (message.entity.ts
 * MessageContent). By the time a request reaches a provider the resolver
 * (message-attachments.resolver.ts) has turned every `file` reference into
 * an `image` or `document` part carrying base64 bytes, or into text; these
 * functions only translate what is left into the vendor's shape. A `file`
 * part that was never resolved (a caller outside the resolver) becomes its
 * text fallback, so no reference ever reaches a vendor as an object it
 * does not know.
 *
 * Content with nothing but text stays a plain string: several
 * OpenAI-compatible servers refuse a part list on an assistant or tool
 * message, and a plain turn has no reason to change shape.
 */

export type Content = string | MessageContent[] | null | undefined;

/** Whether this content carries anything a text-only rendering would lose. */
export function hasMediaParts(content: Content): boolean {
  return Array.isArray(content) && content.some((p) => p && (p.type === 'image' || p.type === 'document'));
}

/** Whether this content still carries a `file` reference to resolve. */
export function hasFileParts(content: Content): boolean {
  return Array.isArray(content) && content.some((p) => p?.type === 'file');
}

/**
 * What a model that cannot take a file reads in its place: the file's
 * extracted text when it has any, else a sentence saying what it is and
 * that this model cannot open it, so the answer does not pretend to have
 * seen it.
 */
export function fileFallbackText(part: MessageContent): string {
  const name = oneLine(part.name || 'attachment');
  if (part.text?.trim()) return `Contents of ${name}:\n${part.text}`;
  const type = part.mimeType ?? '';
  if (type.startsWith('image/')) return `(${name} is an image; the model answering cannot view images.)`;
  if (type === 'application/pdf') return `(${name} is a PDF; the model answering cannot read PDF files.)`;
  return `(${name} was attached; its contents are not readable here.)`;
}

/** Every part as text, joined; for the vendors and formats that take a string only. */
export function contentAsText(content: Content): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part) return '';
      if (part.type === 'text') return part.text ?? '';
      if (part.type === 'file') return fileFallbackText(part);
      if (part.type === 'image') return `[image${part.name ? `: ${oneLine(part.name)}` : ''}]`;
      if (part.type === 'document') return `[document${part.name ? `: ${oneLine(part.name)}` : ''}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** OpenAI chat completions: `text`, `image_url` (a data: URL or a link) and `file` parts. */
export function toOpenAIContent(content: Content): string | Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return content ?? '';
  if (!hasMediaParts(content)) return contentAsText(content);
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'image' && (part.data || part.imageUrl)) {
      out.push({
        type: 'image_url',
        image_url: { url: part.data ? `data:${part.mimeType};base64,${part.data}` : part.imageUrl },
      });
    } else if (part.type === 'document' && part.data) {
      out.push({
        type: 'file',
        file: { filename: part.name || 'document.pdf', file_data: `data:${part.mimeType};base64,${part.data}` },
      });
    } else {
      const text = contentAsText([part]);
      if (text) out.push({ type: 'text', text });
    }
  }
  return out;
}

/** Anthropic Messages: `text`, `image` and `document` blocks with a base64 (or url) source. */
export function toAnthropicContent(content: Content): string | Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return content ?? '';
  if (!hasMediaParts(content)) return contentAsText(content);
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'image' && (part.data || part.imageUrl)) {
      out.push({
        type: 'image',
        source: part.data
          ? { type: 'base64', media_type: part.mimeType, data: part.data }
          : { type: 'url', url: part.imageUrl },
      });
    } else if (part.type === 'document' && part.data) {
      out.push({ type: 'document', source: { type: 'base64', media_type: part.mimeType, data: part.data } });
    } else {
      const text = contentAsText([part]);
      if (text) out.push({ type: 'text', text });
    }
  }
  return out;
}

/** Gemini generateContent: `text` and `inline_data` parts. A bare link has no inline form and stays text. */
export function toGeminiParts(content: Content): Array<Record<string, unknown>> {
  if (!Array.isArray(content) || !hasMediaParts(content)) return [{ text: contentAsText(content) }];
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part) continue;
    if ((part.type === 'image' || part.type === 'document') && part.data) {
      out.push({ inline_data: { mime_type: part.mimeType, data: part.data } });
    } else {
      const text = contentAsText([part]);
      if (text) out.push({ text });
    }
  }
  return out;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 120);
}
