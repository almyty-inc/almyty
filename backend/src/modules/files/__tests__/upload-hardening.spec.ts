import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FilesService } from '../files.service';
import { StorageService } from '../storage.service';
import { TextExtractorService } from '../text-extractor.service';
import { AgentFile } from '../../../entities/file.entity';

/**
 * Upload-path hardening, exercised against the real local storage
 * provider and the real text extractor. Only the repository is faked.
 */
describe('FilesService upload hardening', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';

  let tmpDir: string;
  let repo: any;
  let service: FilesService;

  const listFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listFiles(full));
      else out.push(full);
    }
    return out;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almyty-upload-hardening-'));
    repo = {
      create: jest.fn((data: Partial<AgentFile>) => Object.assign(new AgentFile(), data)),
      save: jest.fn(async (f: AgentFile) => f),
    };
    const settings: Record<string, string> = { STORAGE_TYPE: 'local', STORAGE_LOCAL_PATH: tmpDir };
    const config = {
      get: (key: string, def?: unknown) => settings[key] ?? def,
    } as unknown as ConfigService;
    service = new FilesService(
      repo,
      new StorageService(config),
      new TextExtractorService(),
      { log: jest.fn() } as any,
    );
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const txt = (body: Buffer | string, name = 'notes.txt') => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return { buffer, originalname: name, mimetype: 'text/plain', size: buffer.length };
  };

  it('refuses an agentId that walks the storage key into another org', async () => {
    await expect(
      service.upload(ORG_A, txt('planted'), { agentId: `../${ORG_B}/agent` }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(listFiles(path.join(tmpDir, ORG_B))).toEqual([]);
    expect(listFiles(tmpDir)).toEqual([]);
  });

  it('refuses a runId that is not an id', async () => {
    await expect(
      service.upload(ORG_A, txt('x'), { runId: 'not-a-run/../../x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps every stored object under the uploading org', async () => {
    const agentId = '33333333-3333-4333-8333-333333333333';
    const saved = await service.upload(ORG_A, txt('ok'), { agentId });
    expect(saved.storageKey.startsWith(`${ORG_A}/${agentId}/`)).toBe(true);
    const files = listFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].startsWith(path.join(tmpDir, ORG_A) + path.sep)).toBe(true);
  });

  it('stores a UTF-16 text file without NUL bytes in extractedText', async () => {
    // Windows editors save .txt as UTF-16LE; every ASCII char carries a
    // 0x00 byte, which Postgres refuses in a text column, failing the
    // whole upload.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello world', 'utf16le')]);
    const saved = await service.upload(ORG_A, txt(utf16));
    expect(saved.extractedText).not.toBeNull();
    expect(saved.extractedText.includes('\u0000')).toBe(false);
    expect(saved.extractedText).toContain('hello world');
  });

  it('never hands a NUL byte to the text column for binary content named .log', async () => {
    const saved = await service.upload(
      ORG_A,
      txt(Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x43]), 'dump.log'),
    );
    expect(saved.extractedText ?? '').not.toContain('\u0000');
  });

  it('removes the stored object when the row cannot be saved', async () => {
    repo.save.mockRejectedValueOnce(new Error('db down'));
    await expect(service.upload(ORG_A, txt('orphan?'))).rejects.toThrow('db down');
    expect(listFiles(tmpDir)).toEqual([]);
  });
});