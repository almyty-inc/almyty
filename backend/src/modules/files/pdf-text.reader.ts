import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { PdfTextWorkerInput, PdfTextWorkerOutput } from './pdf-text-worker';

/**
 * A PDF's text, for the models that cannot read a PDF themselves (every
 * provider but the few that take one natively gets this text in its place)
 * and for search. Parsing runs in a worker (pdf-text-worker.ts) with a
 * time and memory cap; a PDF past any cap, a scanned PDF with no text
 * layer, or one that fails to parse gives null, never an error.
 *
 * The caps are read from the environment on every call:
 * - FILES_PDF_TEXT_MAX_BYTES  largest PDF parsed (default 25 MB)
 * - FILES_PDF_TEXT_MAX_PAGES  pages read, from the first (default 200)
 * - FILES_PDF_TEXT_TIMEOUT_MS time one PDF may take (default 20 s)
 * - FILES_PDF_TEXT_MEMORY_MB  the worker's heap (default 256 MB)
 * FILES_PDF_TEXT_MAX_BYTES=0 turns PDF text off.
 */
export interface PdfTextLimits {
  maxBytes: number;
  maxPages: number;
  timeoutMs: number;
  memoryMb: number;
}

export interface PdfText {
  text: string;
  pages: number;
  truncated: boolean;
}

const DEFAULTS: PdfTextLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxPages: 200,
  timeoutMs: 20_000,
  memoryMb: 256,
};

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export function pdfTextLimits(): PdfTextLimits {
  return {
    maxBytes: intFromEnv('FILES_PDF_TEXT_MAX_BYTES', DEFAULTS.maxBytes, 0),
    maxPages: intFromEnv('FILES_PDF_TEXT_MAX_PAGES', DEFAULTS.maxPages, 1),
    timeoutMs: intFromEnv('FILES_PDF_TEXT_TIMEOUT_MS', DEFAULTS.timeoutMs, 100),
    memoryMb: intFromEnv('FILES_PDF_TEXT_MEMORY_MB', DEFAULTS.memoryMb, 32),
  };
}

/** Whether these bytes are a PDF: they start with `%PDF-` (after at most a little junk, as readers allow). */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes('%PDF-');
}

export class PdfTextReader {
  private readonly logger = new Logger(PdfTextReader.name);

  /** The text of `bytes`, at most `maxChars` of it; null when there is none to read. */
  async read(bytes: Buffer, maxChars: number, limits: PdfTextLimits = pdfTextLimits()): Promise<PdfText | null> {
    if (limits.maxBytes === 0 || bytes.length === 0 || bytes.length > limits.maxBytes || !looksLikePdf(bytes)) return null;
    const out = await this.runWorker({ bytes: new Uint8Array(bytes), maxPages: limits.maxPages, maxChars }, limits);
    if ('error' in out) {
      this.logger.debug(`PDF text not read: ${out.error}`);
      return null;
    }
    return out.text.trim() ? { text: out.text, pages: out.pages, truncated: out.truncated } : null;
  }

  private runWorker(input: PdfTextWorkerInput, limits: PdfTextLimits): Promise<PdfTextWorkerOutput> {
    let workerPath = path.join(__dirname, 'pdf-text-worker.js');
    const compiled = fs.existsSync(workerPath);
    if (!compiled) workerPath = path.join(__dirname, 'pdf-text-worker.ts');
    return new Promise((resolve) => {
      let settled = false;
      const done = (out: PdfTextWorkerOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(out);
      };
      const worker = new Worker(workerPath, {
        workerData: input,
        // Nothing of the backend's environment: the worker reads bytes it is handed.
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb, maxYoungGenerationSizeMb: Math.max(16, Math.ceil(limits.memoryMb / 4)) },
        execArgv: compiled ? [] : ['-r', 'ts-node/register/transpile-only'],
      } as any);
      const timer = setTimeout(() => done({ ok: false, error: `took longer than ${limits.timeoutMs} ms` }), limits.timeoutMs);
      worker.once('message', (msg: PdfTextWorkerOutput) => done(msg));
      worker.once('error', (err: Error) => done({ ok: false, error: err.message }));
      worker.once('exit', (code) => done({ ok: false, error: `worker exited (${code})` }));
    });
  }
}
