import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TextExtractorService } from '../text-extractor.service';
import { looksLikePdf, pdfTextLimits } from '../pdf-text.reader';

/**
 * A PDF's text is read, so a model that cannot open a PDF (every provider
 * but the few that take one natively) reads what it says, not only its
 * name. The fixture is a real two-page PDF with a text layer; parsing runs
 * in the capped worker the service uses in production.
 */
const PDF = readFileSync(join(__dirname, 'fixtures', 'payout-report.pdf'));

describe('TextExtractorService: PDF text', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('FILES_PDF_TEXT_')) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('reads the text of every page of a PDF', async () => {
    const text = await new TextExtractorService().extract(PDF, 'application/pdf', 'payout-report.pdf');
    expect(text).toContain('Northwind payout report');
    expect(text).toContain('Total paid out: 1,284.50 EUR');
  }, 30_000);

  it('reads a PDF spooled to disk whole, not just the first megabyte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-text-'));
    try {
      const path = join(dir, 'upload');
      writeFileSync(path, PDF);
      const text = await new TextExtractorService().extractFromFile(path, PDF.length, 'application/pdf', 'report.pdf');
      expect(text).toContain('1,284.50 EUR');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('stops at FILES_PDF_TEXT_MAX_PAGES and says the rest was not read', async () => {
    process.env.FILES_PDF_TEXT_MAX_PAGES = '1';
    const text = await new TextExtractorService().extract(PDF, 'application/pdf', 'payout-report.pdf');
    expect(text).toContain('Northwind payout report');
    expect(text).not.toContain('1,284.50');
    expect(text).toContain('only the start of this PDF was read');
  }, 30_000);

  it('leaves a PDF past FILES_PDF_TEXT_MAX_BYTES unread, and reads none with 0', async () => {
    process.env.FILES_PDF_TEXT_MAX_BYTES = String(PDF.length - 1);
    expect(await new TextExtractorService().extract(PDF, 'application/pdf', 'a.pdf')).toBeNull();
    process.env.FILES_PDF_TEXT_MAX_BYTES = '0';
    expect(await new TextExtractorService().extract(PDF, 'application/pdf', 'a.pdf')).toBeNull();
  });

  it('gives null, not an error, for bytes that only claim to be a PDF', async () => {
    const service = new TextExtractorService();
    expect(await service.extract(Buffer.from('%PDF-1.4 not really'), 'application/pdf', 'x.pdf')).toBeNull();
    expect(await service.extract(Buffer.from('hello'), 'application/pdf', 'x.pdf')).toBeNull();
  }, 30_000);

  it('reads the caps from the environment, with defaults', () => {
    expect(pdfTextLimits()).toEqual({ maxBytes: 25 * 1024 * 1024, maxPages: 200, timeoutMs: 20_000, memoryMb: 256 });
    process.env.FILES_PDF_TEXT_TIMEOUT_MS = '5000';
    process.env.FILES_PDF_TEXT_MAX_PAGES = 'lots';
    expect(pdfTextLimits()).toMatchObject({ timeoutMs: 5000, maxPages: 200 });
    expect(looksLikePdf(PDF)).toBe(true);
    expect(looksLikePdf(Buffer.from('PK\u0003\u0004'))).toBe(false);
  });
});
