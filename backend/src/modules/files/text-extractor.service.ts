import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';

/**
 * Hard cap on how many bytes of an uploaded text file we turn
 * into the searchable `extractedText` column. Without this, a
 * 49 MB text file (the upload size cap is 50 MB) gets fully
 * buffered into a string and written to the DB — memory-bloat
 * DoS on the extraction path, and an unbounded text column in
 * the `files` table.
 *
 * 1 MB is plenty for a full-text search index; longer documents
 * get their content truncated with an ellipsis so downstream
 * search still has something to index.
 */
const EXTRACT_MAX_BYTES = 1 * 1024 * 1024;
const EXTRACT_TRUNCATED_SUFFIX = '\n\n…[truncated — file exceeds 1 MB extraction cap]';

@Injectable()
export class TextExtractorService {
  private readonly logger = new Logger(TextExtractorService.name);

  /**
   * Extract text from file content based on MIME type. Bounded at
   * EXTRACT_MAX_BYTES to prevent memory-bloat DoS on very large
   * text files.
   */
  async extract(buffer: Buffer, mimeType: string, fileName: string): Promise<string | null> {
    try {
      const isText =
        this.isTextFile(mimeType, fileName) ||
        mimeType === 'text/csv' ||
        mimeType === 'application/json';
      if (!isText) {
        // For PDF, DOCX, etc. — return null for now.
        // Can be extended with pdf-parse, mammoth, etc.
        this.logger.debug(`No text extractor for MIME type: ${mimeType}`);
        return null;
      }

      if (buffer.length <= EXTRACT_MAX_BYTES) {
        return this.decode(buffer);
      }

      // File exceeds the cap — slice at the byte boundary, convert
      // to string, and append the truncation marker so the DB
      // column stays bounded.
      this.logger.debug(
        `Truncating extracted text for ${fileName}: ${buffer.length} > ${EXTRACT_MAX_BYTES} bytes`,
      );
      return this.decode(buffer.subarray(0, EXTRACT_MAX_BYTES)) + EXTRACT_TRUNCATED_SUFFIX;
    } catch (error) {
      this.logger.warn(`Text extraction failed for ${fileName}: ${error.message}`);
      return null;
    }
  }

  /**
   * extract() for an upload spooled to disk (files/temp-upload.ts): reads
   * no more of the file than the extraction cap plus one byte, which is
   * all extract() looks at, so a 50 MB upload is never held whole.
   */
  async extractFromFile(filePath: string, size: number, mimeType: string, fileName: string): Promise<string | null> {
    if (!(this.isTextFile(mimeType, fileName) || mimeType === 'text/csv' || mimeType === 'application/json')) {
      return this.extract(Buffer.alloc(0), mimeType, fileName);
    }
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(filePath, 'r');
      const head = Buffer.alloc(Math.min(size, EXTRACT_MAX_BYTES + 1));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      return this.extract(head.subarray(0, bytesRead), mimeType, fileName);
    } catch (error: any) {
      this.logger.warn(`Text extraction failed for ${fileName}: ${error.message}`);
      return null;
    } finally {
      await handle?.close();
    }
  }

  /**
   * Bytes to a string Postgres will store. A text column refuses U+0000,
   * so a NUL anywhere failed the whole upload: every UTF-16 file (what
   * Windows editors write for .txt) and any binary named .log or .env.
   * Honour a UTF-16 byte-order mark, then drop whatever NULs remain.
   */
  private decode(buffer: Buffer): string {
    let text: string;
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      text = buffer.subarray(2, buffer.length - (buffer.length % 2)).toString('utf16le');
    } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      const body = Buffer.from(buffer.subarray(2, buffer.length - (buffer.length % 2)));
      text = body.swap16().toString('utf16le');
    } else {
      text = buffer.toString('utf-8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    return text.split('\u0000').join('');
  }

  private isTextFile(mimeType: string, fileName: string): boolean {
    const textMimes = ['text/plain', 'text/markdown', 'text/html', 'text/xml', 'application/xml'];
    const textExtensions = ['.txt', '.md', '.markdown', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.log', '.env'];

    if (textMimes.includes(mimeType)) return true;
    return textExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
  }
}
