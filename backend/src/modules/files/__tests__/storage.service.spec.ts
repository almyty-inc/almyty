import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('StorageService (local provider)', () => {
  let service: StorageService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));

    const mockConfigService = {
      get: jest.fn((key: string, defaultVal?: string) => {
        if (key === 'STORAGE_TYPE') return 'local';
        if (key === 'STORAGE_LOCAL_PATH') return tmpDir;
        if (key === 'API_BASE_URL') return 'http://localhost:3000';
        return defaultVal;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should initialize with local provider by default', () => {
    expect(service).toBeDefined();
  });

  describe('upload', () => {
    it('should write file and return URL', async () => {
      const data = Buffer.from('test file content');
      const url = await service.upload('org-1/test.txt', data, 'text/plain');

      expect(url).toBe('http://localhost:3000/files/org-1/test.txt');

      const filePath = path.join(tmpDir, 'org-1', 'test.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath).toString()).toBe('test file content');
    });
  });

  describe('download', () => {
    it('should read file content', async () => {
      // Create the file first
      const filePath = path.join(tmpDir, 'org-1');
      fs.mkdirSync(filePath, { recursive: true });
      fs.writeFileSync(path.join(filePath, 'test.txt'), 'file content');

      const buffer = await service.download('org-1/test.txt');

      expect(buffer.toString()).toBe('file content');
    });
  });

  describe('delete', () => {
    it('should remove file', async () => {
      // Create the file first
      const filePath = path.join(tmpDir, 'to-delete');
      fs.mkdirSync(filePath, { recursive: true });
      const fullPath = path.join(filePath, 'file.txt');
      fs.writeFileSync(fullPath, 'delete me');

      expect(fs.existsSync(fullPath)).toBe(true);

      await service.delete('to-delete/file.txt');

      expect(fs.existsSync(fullPath)).toBe(false);
    });

    it('should not throw when deleting non-existent file', async () => {
      await expect(service.delete('nonexistent/file.txt')).resolves.not.toThrow();
    });
  });

  describe('getSignedUrl', () => {
    it('should return a download URL for local provider', async () => {
      const url = await service.getSignedUrl('org-1/test.txt');
      expect(url).toBe('http://localhost:3000/files/org-1/test.txt/download');
    });
  });
});
