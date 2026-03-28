import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TextExtractorService {
  private readonly logger = new Logger(TextExtractorService.name);

  /**
   * Extract text from file content based on MIME type
   */
  async extract(buffer: Buffer, mimeType: string, fileName: string): Promise<string | null> {
    try {
      if (this.isTextFile(mimeType, fileName)) {
        return buffer.toString('utf-8');
      }

      if (mimeType === 'text/csv') {
        return buffer.toString('utf-8');
      }

      if (mimeType === 'application/json') {
        return buffer.toString('utf-8');
      }

      // For PDF, DOCX, etc. — return null for now
      // Can be extended with pdf-parse, mammoth, etc.
      this.logger.debug(`No text extractor for MIME type: ${mimeType}`);
      return null;
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
