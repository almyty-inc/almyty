import { Injectable, Logger } from '@nestjs/common';

import { EgressError, ResponseTooLargeError, safeFetch } from '../../../common/security/safe-fetch';
import { parseMediaType } from '../../files/media-type';
import { TextExtractorService } from '../../files/text-extractor.service';

/** What an adapter hands over for one file someone sent: a link, its kind, its name. */
export interface InboundAttachment {
  url: string;
  type: string;
  name: string;
}

/**
 * Files someone sent on a channel, as the agent reads them.
 *
 * A run's input is text: the runtime has no image or file part, and the
 * OpenAI-compatible surface flattens one to its name
 * (agents/compat-conversation.helper.ts). So each file reaches the agent
 * as a line naming it, its type and its size, and a text file as its
 * text as well. Nothing is stored: the bytes are read, described and
 * dropped.
 *
 * The link comes from the relay's webhook body, which the relay chose and
 * a forger with the webhook secret could choose too, so it is fetched
 * like any other URL someone else picked (common/security/safe-fetch.ts):
 * https only, no private or metadata address in any spelling, the address
 * pinned at connect, every redirect hop re-checked, no credentials sent,
 * a deadline for the whole exchange and a size cap on the body.
 */
@Injectable()
export class ChannelAttachmentReader {
  private readonly logger = new Logger(ChannelAttachmentReader.name);

  /** Files one message is read for; the rest are named as not read. */
  static readonly MAX_ATTACHMENTS = 5;
  /** The largest file read. Sendblue's documented media ceiling. */
  static readonly MAX_BYTES = 10 * 1024 * 1024;
  /** One file, start to finish. */
  static readonly TIMEOUT_MS = 20_000;
  /** CDN links commonly redirect once or twice to the object. */
  static readonly MAX_REDIRECTS = 3;
  /** The most text one file adds to the agent's input. */
  static readonly MAX_TEXT_CHARS = 20_000;

  constructor(private readonly textExtractor: TextExtractorService) {}

  /**
   * The message as the agent reads it: what the person typed, then one
   * block per file. Unchanged when nothing was attached.
   */
  async inputWith(text: string, attachments: InboundAttachment[] | undefined): Promise<string> {
    if (!attachments?.length) return text;
    const blocks: string[] = [];
    for (const [index, sent] of attachments.entries()) {
      // The name is read off a URL someone else chose: one line, no brackets, bounded.
      const attachment = { ...sent, name: String(sent.name ?? 'attachment').replace(/[\r\n\[\]]+/g, ' ').slice(0, 120) };
      if (index >= ChannelAttachmentReader.MAX_ATTACHMENTS) {
        blocks.push(`[Attachment: ${attachment.name} was not read: only the first ${ChannelAttachmentReader.MAX_ATTACHMENTS} files of a message are]`);
        continue;
      }
      blocks.push(await this.describe(attachment));
    }
    return [text.trim(), ...blocks].filter(Boolean).join('\n\n');
  }

  private async describe(attachment: InboundAttachment): Promise<string> {
    // The relays only ever hand over https links; anything else did not come from them.
    if (!/^https:\/\//i.test(attachment.url)) return `[Attachment: ${attachment.name} was not read: its address is not allowed]`;
    try {
      const res = await safeFetch(attachment.url, {
        method: 'GET',
        maxBytes: ChannelAttachmentReader.MAX_BYTES,
        timeoutMs: ChannelAttachmentReader.TIMEOUT_MS,
        maxRedirects: ChannelAttachmentReader.MAX_REDIRECTS,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return `[Attachment: ${attachment.name} could not be read]`;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const type = parseMediaType(res.headers.get('content-type')) ?? attachment.type;
      const head = `[Attachment: ${attachment.name} (${type}, ${sizeOf(buffer.length)})]`;
      const extracted = await this.textExtractor.extract(buffer, type, attachment.name);
      if (!extracted?.trim()) return head;
      const body =
        extracted.length > ChannelAttachmentReader.MAX_TEXT_CHARS
          ? `${extracted.slice(0, ChannelAttachmentReader.MAX_TEXT_CHARS)}\n[truncated]`
          : extracted;
      return `${head}\n${body}`;
    } catch (err) {
      // The URL is not logged: a signed CDN link is a credential for the file.
      const reason =
        err instanceof ResponseTooLargeError
          ? `it is larger than ${sizeOf(ChannelAttachmentReader.MAX_BYTES)}`
          : err instanceof EgressError
            ? 'its address is not allowed'
            : 'it could not be fetched';
      this.logger.warn(`inbound attachment not read (${attachment.name}): ${reason}`);
      return `[Attachment: ${attachment.name} was not read: ${reason}]`;
    }
  }
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}
