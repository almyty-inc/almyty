import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';

import { EgressError, ResponseTooLargeError } from '../../../common/security/safe-fetch';
import type { MessageContent } from '../../../entities/message.entity';
import type { AgentFile } from '../../../entities/file.entity';
import { FilesService } from '../../files/files.service';
import { MODEL_IMAGE_TYPES, parseMediaType, sniffMediaType } from '../../files/media-type';
import { TextExtractorService } from '../../files/text-extractor.service';
import type { BaseAdapter, InboundAttachment } from './adapters/base.adapter';

/** Who a stored attachment belongs to until its conversation exists. */
export interface AttachmentOwner {
  organizationId: string;
  agentId: string | null;
  gatewayId: string;
  threadId?: string | null;
}

/** What one message's files became. */
export interface ReadAttachments {
  /** One line per file for the message text: its name, type and size, or why it was not read. */
  lines: string[];
  /** A file reference per stored file, for the user message (message.entity.ts MessageContent). */
  parts: MessageContent[];
  /** The stored files, to file under the conversation once the run has one. */
  fileIds: string[];
}

/**
 * Files someone sent on a channel, as the agent gets them.
 *
 * Each file is fetched the way its platform wants (the adapter's
 * `fetchAttachment`: a public link through the egress guard, or the
 * platform's API with the bot's token, only ever to the platform's own
 * host), capped in size and time, and checked against its bytes rather
 * than the type the sender's side claimed.
 *
 * What a model can take -- an image, a PDF, a text file -- is stored as a
 * file (files module) under the conversation it arrived in, so retention
 * and visitor erasure reach it with the conversation, and the user message
 * carries a reference to it. Which model answers decides what it gets:
 * the image or the PDF itself when its card says it takes them, the text
 * of a text file, or a sentence saying what was sent
 * (llm-providers/message-attachments.resolver.ts). The message text also
 * gains a line naming each file, which is what a transcript shows.
 *
 * Anything else (video, audio, an archive) is named and not stored. So is
 * a file past the caps, or one the platform would not hand over.
 */
@Injectable()
export class ChannelAttachmentReader {
  private readonly logger = new Logger(ChannelAttachmentReader.name);

  /** Files one message is read for; the rest are named as not read. */
  static readonly MAX_ATTACHMENTS = 5;
  /** The largest file read. */
  static readonly MAX_BYTES = 10 * 1024 * 1024;
  /** One file, start to finish. */
  static readonly TIMEOUT_MS = 20_000;
  /** The most text one file adds to what a model reads. */
  static readonly MAX_TEXT_CHARS = 20_000;

  constructor(
    private readonly textExtractor: TextExtractorService,
    // Optional so the reader can be built alone; without it a file is
    // described (and a text file's text read) but nothing is stored.
    @Optional() private readonly files?: FilesService,
  ) {}

  /** The message text followed by one line per file. */
  static textWith(text: string, lines: string[]): string {
    return [text.trim(), ...lines].filter(Boolean).join('\n\n');
  }

  async read(
    adapter: BaseAdapter,
    config: Record<string, any>,
    attachments: InboundAttachment[] | undefined,
    owner: AttachmentOwner,
  ): Promise<ReadAttachments> {
    const out: ReadAttachments = { lines: [], parts: [], fileIds: [] };
    for (const [index, sent] of (attachments ?? []).entries()) {
      const name = cleanName(sent?.name);
      if (index >= ChannelAttachmentReader.MAX_ATTACHMENTS) {
        out.lines.push(`[Attachment: ${name} was not read: only the first ${ChannelAttachmentReader.MAX_ATTACHMENTS} files of a message are]`);
        continue;
      }
      const one = await this.readOne(adapter, config, sent, name, owner);
      out.lines.push(one.line);
      if (one.part) out.parts.push(one.part);
      if (one.fileId) out.fileIds.push(one.fileId);
    }
    return out;
  }

  /**
   * File one message's attachments under the conversation (and run) that
   * reads them, which is what retention and visitor erasure find them by.
   * A failure is logged, not thrown: the reply matters more than the link.
   */
  async fileUnder(organizationId: string, fileIds: string[], conversationId: string | null | undefined, runId?: string | null): Promise<void> {
    if (!fileIds.length || !conversationId || !this.files) return;
    try {
      await this.files.attachToConversation(organizationId, fileIds, conversationId, runId);
    } catch (err: any) {
      this.logger.warn(`attachments not filed under conversation ${conversationId}: ${err?.message ?? err}`);
    }
  }

  /** Remove attachments stored for a message no run will read. */
  async discard(organizationId: string, fileIds: string[]): Promise<void> {
    if (!fileIds.length || !this.files) return;
    await this.files.removeMany(organizationId, fileIds);
  }

  /**
   * Erase what a visitor sent: the files filed under these conversations
   * and any upload of theirs not sent yet (widget thread erasure).
   */
  async erase(
    organizationId: string,
    conversationIds: string[],
    unsent?: { gatewayId: string; endUserId?: string; threadId?: string },
  ): Promise<void> {
    if (!this.files) return;
    await this.files.removeForConversations(organizationId, conversationIds);
    if (unsent) await this.files.removeUnsentUploads(organizationId, unsent);
  }

  // ---------------------------------------------------------------------------
  // Web chat and widget uploads
  // ---------------------------------------------------------------------------

  /** Text types a visitor may upload besides images and PDFs. */
  static readonly UPLOAD_TEXT_TYPES: ReadonlySet<string> = new Set([
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json',
  ]);

  /**
   * Store a file a web chat or widget visitor uploaded, before they send
   * the message it goes with. Only what a model can take is accepted: an
   * image or a PDF (by its bytes, whatever it claims), or a text file. The
   * file waits, with no conversation, until the message that names it is
   * sent (`fromFiles`); one never sent is removed by the retention sweep a
   * day later, and with the visitor when they erase their data.
   */
  async storeUpload(
    bytes: Buffer,
    name: unknown,
    declared: unknown,
    owner: AttachmentOwner & { endUserId?: string },
    source: 'web_chat_upload' | 'widget_upload',
  ): Promise<{ id: string; name: string; mimeType: string; size: number } | { refused: string }> {
    if (!this.files) return { refused: 'Attachments are not available here.' };
    if (!bytes.length) return { refused: 'The file is empty.' };
    if (bytes.length > ChannelAttachmentReader.MAX_BYTES) {
      return { refused: `The file is larger than ${sizeOf(ChannelAttachmentReader.MAX_BYTES)}.` };
    }
    const fileName = cleanName(name);
    const sniffed = sniffMediaType(bytes);
    const claimed = parseMediaType(declared);
    let type: string | null = sniffed && (MODEL_IMAGE_TYPES.has(sniffed) || sniffed === 'application/pdf') ? sniffed : null;
    let text: string | undefined;
    if (!type && !sniffed && claimed && ChannelAttachmentReader.UPLOAD_TEXT_TYPES.has(claimed)) {
      const extracted = await this.textExtractor.extract(bytes, claimed, fileName);
      if (extracted?.trim()) {
        type = claimed;
        text = extracted.length > ChannelAttachmentReader.MAX_TEXT_CHARS
          ? `${extracted.slice(0, ChannelAttachmentReader.MAX_TEXT_CHARS)}\n[truncated]`
          : extracted;
      }
    }
    if (!type) return { refused: 'Only images (PNG, JPEG, GIF, WebP), PDFs and text files can be sent.' };
    const stored = await this.files.storeBytes(owner.organizationId, bytes, { name: fileName, mimeType: type }, {
      agentId: owner.agentId,
      extractedText: text ?? null,
      metadata: {
        source,
        gatewayId: owner.gatewayId,
        ...(owner.endUserId ? { endUserId: owner.endUserId } : {}),
        ...(owner.threadId ? { threadId: owner.threadId } : {}),
      },
    });
    return { id: stored.id, name: stored.name, mimeType: stored.mimeType, size: stored.size };
  }

  /** A message's uploaded files as the agent gets them: a line each, and a reference each. */
  static fromFiles(files: Array<Pick<AgentFile, 'id' | 'name' | 'mimeType' | 'size' | 'extractedText'>>): ReadAttachments {
    const out: ReadAttachments = { lines: [], parts: [], fileIds: [] };
    for (const file of files.slice(0, ChannelAttachmentReader.MAX_ATTACHMENTS)) {
      const name = cleanName(file.name);
      out.lines.push(`[Attachment: ${name} (${file.mimeType}, ${sizeOf(file.size)})]`);
      out.fileIds.push(file.id);
      out.parts.push({
        type: 'file',
        fileId: file.id,
        mimeType: file.mimeType,
        name,
        size: file.size,
        ...(file.extractedText?.trim() ? { text: file.extractedText.slice(0, ChannelAttachmentReader.MAX_TEXT_CHARS) } : {}),
      });
    }
    return out;
  }

  private async readOne(
    adapter: BaseAdapter,
    config: Record<string, any>,
    sent: InboundAttachment,
    name: string,
    owner: AttachmentOwner,
  ): Promise<{ line: string; part?: MessageContent; fileId?: string }> {
    let bytes: Buffer;
    let served: string | undefined;
    try {
      if (sent.data) {
        if (sent.data.length > ChannelAttachmentReader.MAX_BYTES) throw new ResponseTooLargeError(ChannelAttachmentReader.MAX_BYTES);
        bytes = sent.data;
      } else {
        const fetched = await adapter.fetchAttachment(sent, config, {
          maxBytes: ChannelAttachmentReader.MAX_BYTES,
          timeoutMs: ChannelAttachmentReader.TIMEOUT_MS,
        });
        if (!fetched) return { line: `[Attachment: ${name} was not read: this channel does not hand over its files]` };
        bytes = fetched.bytes;
        served = fetched.type;
      }
    } catch (err) {
      // The link is not logged: a signed CDN link is a credential for the
      // file, and a Telegram file link carries the bot token.
      const reason =
        err instanceof ResponseTooLargeError
          ? `it is larger than ${sizeOf(ChannelAttachmentReader.MAX_BYTES)}`
          : err instanceof EgressError
            ? 'its address is not allowed'
            : 'it could not be fetched';
      this.logger.warn(`inbound attachment not read on ${adapter.type} (${name}): ${reason}`);
      return { line: `[Attachment: ${name} was not read: ${reason}]` };
    }

    // A file host that answers a file request with a web page (a sign-in
    // page, an error page) did not hand over the file.
    if (served === 'text/html' && parseMediaType(sent.type) !== 'text/html') {
      this.logger.warn(`inbound attachment not read on ${adapter.type} (${name}): the host answered with a web page`);
      return { line: `[Attachment: ${name} was not read: it could not be fetched]` };
    }
    // The bytes decide what a file is. A claim of image or PDF the bytes do
    // not bear out is not believed.
    const sniffed = sniffMediaType(bytes);
    let type = sniffed ?? served ?? parseMediaType(sent.type) ?? 'application/octet-stream';
    if (!sniffed && (MODEL_IMAGE_TYPES.has(type) || type === 'application/pdf')) type = 'application/octet-stream';

    const head = `[Attachment: ${name} (${type}, ${sizeOf(bytes.length)})]`;
    const extracted = await this.textExtractor.extract(bytes, type, name);
    const text = extracted?.trim()
      ? extracted.length > ChannelAttachmentReader.MAX_TEXT_CHARS
        ? `${extracted.slice(0, ChannelAttachmentReader.MAX_TEXT_CHARS)}\n[truncated]`
        : extracted
      : undefined;

    const readable = MODEL_IMAGE_TYPES.has(type) || type === 'application/pdf' || !!text;
    if (!readable) {
      return { line: `[Attachment: ${name} (${type}, ${sizeOf(bytes.length)}) was not read: only images, PDFs and text files are]` };
    }
    if (!this.files) return { line: text ? `${head}\n${text}` : head };

    try {
      const stored = await this.files.storeBytes(owner.organizationId, bytes, { name, mimeType: type }, {
        agentId: owner.agentId,
        extractedText: text ?? null,
        metadata: {
          source: 'channel_attachment',
          channel: adapter.type,
          gatewayId: owner.gatewayId,
          ...(owner.threadId ? { threadId: owner.threadId } : {}),
        },
      });
      return {
        line: head,
        fileId: stored.id,
        part: { type: 'file', fileId: stored.id, mimeType: type, name, size: bytes.length, ...(text ? { text } : {}) },
      };
    } catch (err: any) {
      // Not stored, so no model sees the file itself; its text still reaches
      // the agent in the message.
      this.logger.warn(`inbound attachment not stored on ${adapter.type} (${name}): ${err?.message ?? err}`);
      return { line: text ? `${head}\n${text}` : head };
    }
  }
}

/**
 * The upload ids a web chat or widget message names: a list of strings,
 * at most ChannelAttachmentReader.MAX_ATTACHMENTS of them.
 */
export function attachmentIdsFrom(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new BadRequestException('attachmentIds must be a list of ids');
  }
  if (value.length > ChannelAttachmentReader.MAX_ATTACHMENTS) {
    throw new BadRequestException(`at most ${ChannelAttachmentReader.MAX_ATTACHMENTS} attachments per message`);
  }
  return value as string[];
}

/** A name read off someone else's delivery: one line, no brackets, bounded. */
function cleanName(name: unknown): string {
  const cleaned = String(name ?? '').replace(/[\u0000-\u001f\u007f\[\]]+/g, ' ').trim().slice(0, 120);
  return cleaned || 'attachment';
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}
