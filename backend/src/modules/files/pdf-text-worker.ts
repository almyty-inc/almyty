/**
 * Reads the text of one PDF, off the main thread (pdf-text.reader.ts runs
 * it with a time and memory cap). A PDF is untrusted input and parsing one
 * is CPU work, so a hostile or huge file costs this worker, never the
 * request loop. Text only: no rendering, no fonts drawn, no scripts run.
 */
import { parentPort, workerData } from 'worker_threads';

export interface PdfTextWorkerInput {
  bytes: Uint8Array;
  maxPages: number;
  maxChars: number;
}

export type PdfTextWorkerOutput = { ok: true; text: string; pages: number; truncated: boolean } | { ok: false; error: string };

async function run(input: PdfTextWorkerInput): Promise<PdfTextWorkerOutput> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(input.bytes, { isEvalSupported: false, disableFontFace: true, verbosity: 0 } as any);
  const total = pdf.numPages;
  const pages = Math.min(total, input.maxPages);
  let text = '';
  let truncated = total > pages;
  for (let n = 1; n <= pages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const line = content.items
      .map((item: any) => (typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : ''))
      .join('')
      .trim();
    if (line) text += (text ? '\n\n' : '') + line;
    if (text.length >= input.maxChars) {
      text = text.slice(0, input.maxChars);
      truncated = true;
      break;
    }
  }
  await (pdf as any).destroy?.();
  return { ok: true, text, pages: total, truncated };
}

if (parentPort && workerData) {
  run(workerData as PdfTextWorkerInput).then(
    (out) => parentPort!.postMessage(out),
    (err: any) => parentPort!.postMessage({ ok: false, error: String(err?.message ?? err).slice(0, 200) }),
  );
}
