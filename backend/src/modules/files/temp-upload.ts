import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
  Type,
  mixin,
} from '@nestjs/common';
import { FileInterceptor, MulterModuleOptions } from '@nestjs/platform-express';
import { MULTER_MODULE_OPTIONS } from '@nestjs/platform-express/multer/files.constants';
import { randomUUID } from 'crypto';
import { promises as fs, mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import * as os from 'os';
import * as path from 'path';
import { Observable, finalize } from 'rxjs';

import { uploadLimits } from './upload-limits';

/**
 * Multipart uploads spooled to disk rather than held in memory.
 *
 * multer's default memory storage kept every upload in the heap until the
 * handler returned: up to 50 MB per concurrent /files/upload on a pod
 * that peaks around 286 MB. Each request now gets a directory of its own
 * under the upload temp dir, the file streams into it, and the directory
 * is removed when the request is done, whether the handler succeeded,
 * threw, or the client went away mid-upload (multer then fails the
 * request; a partly written file goes with the directory).
 *
 * Handlers read `file.path`, never `file.buffer`. Whatever needs the whole
 * content reads the file, which uploadLimits() has already capped.
 */

const UPLOAD_DIR_KEY = Symbol('almyty.uploadDir');

/** How long an orphaned request directory (a crash mid-upload) is kept. */
const STALE_AFTER_MS = 60 * 60 * 1000;

let swept = false;

/** Where request directories go: UPLOAD_TMP_DIR, or `almyty-uploads` under the OS temp dir. */
export function uploadTempRoot(): string {
  const root = process.env.UPLOAD_TMP_DIR || path.join(os.tmpdir(), 'almyty-uploads');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!swept) {
    swept = true;
    void sweepStaleUploads(root);
  }
  return root;
}

/** Remove request directories a previous process left behind. */
export async function sweepStaleUploads(root: string, now = Date.now()): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('req-')) continue;
    const dir = path.join(root, entry.name);
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_AFTER_MS) await fs.rm(dir, { recursive: true, force: true });
  }
}

async function removeRequestDir(req: any): Promise<void> {
  const dir: string | undefined = req?.[UPLOAD_DIR_KEY];
  if (!dir) return;
  req[UPLOAD_DIR_KEY] = undefined;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

const storage = diskStorage({
  destination: (req: any, _file, cb) => cb(null, req[UPLOAD_DIR_KEY]),
  // The client's name never reaches the filesystem; it stays on the
  // file object as `originalname`.
  filename: (_req, _file, cb) => cb(null, randomUUID()),
});

/**
 * The FileInterceptor for `field`, with disk storage, uploadLimits(maxBytes) and
 * cleanup. Module-level multer options (a MulterModule fileFilter) still
 * apply; storage and limits are always these.
 */
export function TempFileInterceptor(field: string, maxBytes: number): Type<NestInterceptor> {
  const Multer = FileInterceptor(field, { storage, limits: uploadLimits(maxBytes) });

  @Injectable()
  class TempFileMixin implements NestInterceptor {
    private readonly logger = new Logger('TempFileInterceptor');
    private readonly multer: NestInterceptor;

    constructor(@Optional() @Inject(MULTER_MODULE_OPTIONS) options: MulterModuleOptions = {}) {
      this.multer = new (Multer as any)(options);
    }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
      const http = context.switchToHttp();
      const req = http.getRequest();
      req[UPLOAD_DIR_KEY] = await fs.mkdtemp(path.join(uploadTempRoot(), 'req-'));
      const cleanup = () =>
        removeRequestDir(req).catch((error) => this.logger.warn(`Could not remove an upload: ${error?.message ?? error}`));

      // A client that goes away mid-upload: multer fails the request, but
      // should it not, the closed response is the other signal. Only
      // before parsing is done; afterwards the handler owns the file.
      let parsed = false;
      http.getResponse()?.once?.('close', () => {
        if (!parsed) void cleanup();
      });

      let handled: Observable<any>;
      try {
        handled = await this.multer.intercept(context, next);
        parsed = true;
      } catch (error) {
        await cleanup();
        throw error;
      }
      return handled.pipe(finalize(() => void cleanup()));
    }
  }

  return mixin(TempFileMixin);
}
