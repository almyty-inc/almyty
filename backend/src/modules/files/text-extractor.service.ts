import { Injectable, Logger } from '@nestjs/common';

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
        return buffer.toString('utf-8');
      }

      // File exceeds the cap — slice at the byte boundary, convert
      // to string, and append the truncation marker so the DB
      // column stays bounded.
      this.logger.debug(
        `Truncating extracted text for ${fileName}: ${buffer.length} > ${EXTRACT_MAX_BYTES} bytes`,
      );
      return buffer.slice(0, EXTRACT_MAX_BYTES).toString('utf-8') + EXTRACT_TRUNCATED_SUFFIX;
    } catch (error) {
      this.logger.warn(`Text extraction failed for ${fileName}: ${error.message}`);
      return null;
    }
  }

  private isTextFile(mimeType: string, fileName: string): boolean {
    const textMimes = ['text/plain', 'text/markdown', 'text/html', 'text/xml', 'application/xml'];
    const textExtensions = ['.txt', '.md', '.markdown', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.log', '.env'];

    if (textMimes.includes(mimeType)) return true;
    return textExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
  }
}
