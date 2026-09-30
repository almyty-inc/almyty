import type { MessageContent } from '../../entities/message.entity';

/**
 * Files attached to a run's input, as both engines carry them.
 *
 * A file travels as a reference to the stored file (`{type: 'file',
 * fileId, mimeType, name, text}`, message.entity.ts) and is resolved into
 * something the model can read only when a model is called
 * (llm-providers/message-attachments.resolver.ts). These helpers put the
 * references on a user message and take them back off.
 */

/** The most files one message carries to a model. */
export const MAX_ATTACHED_FILES = 5;

/** The well-formed file references in a list, at most MAX_ATTACHED_FILES. */
export function fileParts(parts: unknown): MessageContent[] {
  if (!Array.isArray(parts)) return [];
  const out: MessageContent[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as MessageContent;
    if (p.type !== 'file' || typeof p.fileId !== 'string' || !p.fileId) continue;
    out.push({
      type: 'file',
      fileId: p.fileId,
      mimeType: typeof p.mimeType === 'string' ? p.mimeType : 'application/octet-stream',
      name: typeof p.name === 'string' ? p.name : 'attachment',
      ...(typeof p.size === 'number' ? { size: p.size } : {}),
      ...(typeof p.text === 'string' && p.text ? { text: p.text } : {}),
    });
    if (out.length >= MAX_ATTACHED_FILES) break;
  }
  return out;
}

/** A user message's content: the text alone, or the text followed by its files. */
export function withAttachedFiles(text: string, attachments: MessageContent[] | undefined): string | MessageContent[] {
  const files = fileParts(attachments);
  return files.length ? [{ type: 'text', text }, ...files] : text;
}

/**
 * A stored message as the model is sent it: the content string, or, when
 * the message kept file references, the text followed by those files.
 */
export function messageContentForModel(message: { content?: string | null; contentParts?: MessageContent[] | null }): string | MessageContent[] {
  const files = fileParts(message.contentParts);
  return files.length ? [{ type: 'text', text: message.content ?? '' }, ...files] : (message.content ?? '');
}

/**
 * Files a workflow run was invoked with: `input.attachments`, a list of
 * `{fileId, name?, mimeType?}` (or bare file ids) for files the caller
 * uploaded to /files first. The resolver reads each one scoped to the
 * run's organization, so an id from elsewhere resolves to nothing.
 */
export function inputAttachments(input: unknown): MessageContent[] {
  const list = (input as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(list)) return [];
  return fileParts(
    list.map((item) =>
      typeof item === 'string'
        ? { type: 'file', fileId: item }
        : item && typeof item === 'object'
          ? { type: 'file', ...(item as Record<string, unknown>) }
          : null,
    ),
  );
}
