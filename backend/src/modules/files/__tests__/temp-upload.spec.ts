import { BadRequestException, Controller, INestApplication, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';

import { TempFileInterceptor, sweepStaleUploads } from '../temp-upload';
import { listenOnLoopback } from '../../../test/http';
import { snapshotEnv } from '../../../test/env';

/**
 * A real multer request through the interceptor /files/upload and schema
 * import use. The file must land on disk (never in the heap), be readable
 * by the handler, and be gone afterwards: on success, when the handler
 * throws, when multer refuses it, and when the client goes away mid-upload.
 */

let seen: { onDisk: boolean; inMemory: boolean; content: string } | null = null;

@Controller('t')
class UploadProbeController {
  @Post('ok')
  @UseInterceptors(TempFileInterceptor('file', 1024))
  ok(@UploadedFile() file: any) {
    seen = {
      onDisk: typeof file.path === 'string' && fs.existsSync(file.path),
      inMemory: Buffer.isBuffer(file.buffer),
      content: fs.readFileSync(file.path, 'utf8'),
    };
    return { ok: true };
  }

  @Post('boom')
  @UseInterceptors(TempFileInterceptor('file', 1024))
  boom(@UploadedFile() _file: any) {
    throw new BadRequestException('handler failed');
  }
}

describe('uploads are spooled to a temp dir and removed', () => {
  const restore = snapshotEnv('UPLOAD_TMP_DIR');
  let root: string;
  let app: INestApplication;
  let port: number;

  const leftovers = () => fs.readdirSync(root);
  async function settled(): Promise<string[]> {
    const deadline = Date.now() + 3000;
    while (leftovers().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return leftovers();
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-spec-'));
    process.env.UPLOAD_TMP_DIR = root;
    const moduleRef = await Test.createTestingModule({ controllers: [UploadProbeController] }).compile();
    app = await listenOnLoopback(moduleRef.createNestApplication({ logger: false }));
    port = (app.getHttpServer().address() as any).port;
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
    restore();
  });

  beforeEach(() => {
    seen = null;
  });

  it('hands the handler a file on disk and removes it after the response', async () => {
    await request(app.getHttpServer()).post('/t/ok').attach('file', Buffer.from('hello upload'), 'a.txt').expect(201);
    expect(seen).toEqual({ onDisk: true, inMemory: false, content: 'hello upload' });
    expect(await settled()).toEqual([]);
  });

  it('removes the file when the handler throws', async () => {
    await request(app.getHttpServer()).post('/t/boom').attach('file', Buffer.from('x'), 'a.txt').expect(400);
    expect(await settled()).toEqual([]);
  });

  it('removes a file multer refuses as too large', async () => {
    await request(app.getHttpServer()).post('/t/ok').attach('file', Buffer.alloc(4096, 1), 'big.bin').expect(413);
    expect(seen).toBeNull();
    expect(await settled()).toEqual([]);
  });

  it('removes a partly written file when the client goes away mid-upload', async () => {
    const boundary = 'probe-boundary';
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/t/ok',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': 100_000 },
      });
      req.on('error', () => resolve());
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n`);
      req.write(Buffer.alloc(512, 2));
      // Let the server open the file and start writing before hanging up.
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    expect(seen).toBeNull();
    expect(await settled()).toEqual([]);
  });

  it('sweeps request directories a crashed process left behind', async () => {
    const stale = fs.mkdtempSync(path.join(root, 'req-'));
    fs.writeFileSync(path.join(stale, 'orphan'), 'x');
    await sweepStaleUploads(root, Date.now() + 2 * 60 * 60 * 1000);
    expect(leftovers()).toEqual([]);
  });
});
