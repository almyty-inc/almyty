import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { StorageService } from '../storage.service';
import { FilesController } from '../files.controller';
import { allowedUploadType, parseMediaType } from '../media-type';

/**
 * S3 storage is dormant (@aws-sdk/client-s3 is not a dependency), but it
 * must be safe the day it is switched on: the upload type is parsed
 * exactly before it is stored, and a presigned link downloads the object
 * rather than letting the bucket render what the uploader claimed it was.
 */

const sent: any[] = [];
const signed: any[] = [];

jest.mock(
  '@aws-sdk/client-s3',
  () => {
    class Command {
      constructor(public readonly input: any) {}
    }
    return {
      S3Client: class {
        async send(command: any) {
          sent.push(command);
          return {};
        }
      },
      PutObjectCommand: class extends Command {},
      GetObjectCommand: class extends Command {},
      DeleteObjectCommand: class extends Command {},
    };
  },
  { virtual: true },
);

jest.mock(
  '@aws-sdk/s3-request-presigner',
  () => ({
    getSignedUrl: async (_client: any, command: any, options: any) => {
      signed.push({ input: command.input, options });
      return 'https://bucket.example/signed';
    },
  }),
  { virtual: true },
);

function s3Storage(): StorageService {
  const settings: Record<string, string> = {
    STORAGE_TYPE: 's3',
    STORAGE_S3_ENDPOINT: 'https://s3.example',
    STORAGE_S3_ACCESS_KEY: 'k',
    STORAGE_S3_SECRET_KEY: 's',
    STORAGE_S3_BUCKET: 'b',
  };
  return new StorageService({ get: (key: string, def?: unknown) => settings[key] ?? def } as unknown as ConfigService);
}

describe('S3 storage, if enabled', () => {
  beforeEach(() => {
    sent.length = 0;
    signed.length = 0;
  });

  it('presigns links that force a download under a safe type', async () => {
    const storage = s3Storage();
    expect(storage.canPresign).toBe(true);
    await storage.getSignedUrl('org/general/id/page.html', 60, 'page "x".html');
    expect(signed).toHaveLength(1);
    expect(signed[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'org/general/id/page.html',
      ResponseContentType: 'application/octet-stream',
    });
    expect(signed[0].input.ResponseContentDisposition).toMatch(/^attachment; filename="page _x_.html"/);
  });

  it('names the download after the key when no name is given', async () => {
    await s3Storage().getSignedUrl('org/app/builds/artifact.zip');
    expect(signed[0].input.ResponseContentDisposition).toMatch(/^attachment; filename="artifact.zip"/);
  });

  it('stores objects as attachments, streamed from the spooled upload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-spec-'));
    try {
      const file = path.join(dir, 'upload');
      fs.writeFileSync(file, 'hello');
      await s3Storage().uploadFile('org/general/id/a.txt', file, 'text/plain');
      const put = sent[0].input;
      expect(put).toMatchObject({ Key: 'org/general/id/a.txt', ContentType: 'text/plain', ContentLength: 5, ContentDisposition: 'attachment' });
      expect(Buffer.isBuffer(put.Body)).toBe(false);
      // Let the lazily opened file stream close before its folder goes,
      // or its open fails after this test and lands in another suite.
      await new Promise((resolve) => {
        put.Body.once('close', resolve);
        put.Body.once('error', resolve);
        put.Body.destroy();
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('upload media types are parsed exactly', () => {
  it.each([
    'text/plain, text/html',
    'text/plain,text/html',
    'text/plainx',
    'text/plain<script>',
    'text/html',
    'image/svg+xml',
    'application/vnd.openxmlformats-officedocument.',
    'text/plain; charset=utf-8; x',
    '',
    undefined,
  ])('refuses %p', (value) => {
    expect(allowedUploadType(value)).toBeNull();
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['Text/Plain; charset=UTF-8', 'text/plain'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['image/png', 'image/png'],
  ])('accepts %p as %p', (value, type) => {
    expect(allowedUploadType(value)).toBe(type);
  });

  it('parses a single media type only', () => {
    expect(parseMediaType('text/plain; charset="utf-8"')).toBe('text/plain');
    expect(parseMediaType('text/plain text/html')).toBeNull();
  });
});

describe('FilesController.upload: media type', () => {
  const req = { user: { id: 'u-1', currentOrganizationId: 'org-1' } };
  const file = (mimetype: string) => ({ path: '/tmp/x', originalname: 'a.txt', mimetype, size: 1 });

  it('refuses a list of types that starts with an allowed one', async () => {
    const service = { upload: jest.fn() };
    const controller = new FilesController(service as any);
    await expect(controller.upload(file('text/plain, text/html'), undefined as any, undefined as any, req)).rejects.toMatchObject({
      status: 400,
    });
    expect(service.upload).not.toHaveBeenCalled();
  });

  it('stores the parsed type, not the one the client sent', async () => {
    const service = { upload: jest.fn().mockResolvedValue({ id: 'f-1' }) };
    const controller = new FilesController(service as any);
    await controller.upload(file('Text/Plain; charset=utf-8'), undefined as any, undefined as any, req);
    expect(service.upload.mock.calls[0][1].mimetype).toBe('text/plain');
  });
});
