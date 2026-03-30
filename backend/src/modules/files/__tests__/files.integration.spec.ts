import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FilesService } from '../files.service';
import { StorageService } from '../storage.service';
import { TextExtractorService } from '../text-extractor.service';
import { AgentFile } from '../../../entities/file.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Integration tests for FilesService + StorageService + TextExtractorService.
 *
 * Uses REAL StorageService (local filesystem provider) and REAL TextExtractorService
 * to test actual file I/O, text extraction, and the full upload/download pipeline.
 * Only the TypeORM repository is mocked.
 */
describe('FilesService (integration)', () => {
  let filesService: FilesService;
  let storageService: StorageService;
  let textExtractor: TextExtractorService;
  let tmpDir: string;
  let fileStore: AgentFile[];
  let idCounter: number;
  let mockRepo: any;

  beforeEach(async () => {
    // Create a real temp directory for file storage
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almyty-test-files-'));
    fileStore = [];
    idCounter = 0;

    mockRepo = {
      create: jest.fn().mockImplementation((data: Partial<AgentFile>) => {
        const f = new AgentFile();
        Object.assign(f, {
          createdAt: new Date(),
          ...data,
        });
        return f;
      }),
      save: jest.fn().mockImplementation((file: AgentFile) => {
        const existing = fileStore.findIndex(f => f.id === file.id);
        if (existing >= 0) {
          fileStore[existing] = file;
        } else {
          fileStore.push(file);
        }
        return Promise.resolve(file);
      }),
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        const found = fileStore.find(
          f => f.id === where.id && f.organizationId === where.organizationId,
        );
        return Promise.resolve(found || null);
      }),
      remove: jest.fn().mockImplementation((file: AgentFile) => {
        fileStore = fileStore.filter(f => f.id !== file.id);
        return Promise.resolve(file);
      }),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FilesService,
        StorageService,   // REAL service
        TextExtractorService, // REAL service
        {
          provide: getRepositoryToken(AgentFile),
          useValue: mockRepo,
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: any) => {
              const config: Record<string, string> = {
                STORAGE_TYPE: 'local',
                STORAGE_LOCAL_PATH: tmpDir,
                API_BASE_URL: 'http://localhost:3000',
              };
              return config[key] ?? defaultValue;
            },
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(null),
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
            logToolExecution: jest.fn().mockResolvedValue(null),
            logGatewayRequest: jest.fn().mockResolvedValue(null),
            logRunEvent: jest.fn().mockResolvedValue(null),
            computeChanges: jest.fn().mockReturnValue([]),
            findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
            getResourceHistory: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    filesService = module.get<FilesService>(FilesService);
    storageService = module.get<StorageService>(StorageService);
    textExtractor = module.get<TextExtractorService>(TextExtractorService);
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('upload + real filesystem storage', () => {
    it('should upload a text file and store it on disk', async () => {
      const content = 'Hello, this is a test file with some text content.';
      const buffer = Buffer.from(content);

      const result = await filesService.upload('org-1', {
        buffer,
        originalname: 'test.txt',
        mimetype: 'text/plain',
        size: buffer.length,
      });

      expect(result.name).toBe('test.txt');
      expect(result.mimeType).toBe('text/plain');
      expect(result.size).toBe(buffer.length);
      expect(result.storageKey).toContain('org-1');
      expect(result.storageUrl).toContain('http://localhost:3000/files/');

      // Verify file actually exists on disk
      const filePath = path.join(tmpDir, result.storageKey);
      expect(fs.existsSync(filePath)).toBe(true);
      const diskContent = fs.readFileSync(filePath, 'utf-8');
      expect(diskContent).toBe(content);
    });

    it('should extract text from a text/plain file', async () => {
      const content = 'This is plain text content that should be extracted.';
      const buffer = Buffer.from(content);

      const result = await filesService.upload('org-1', {
        buffer,
        originalname: 'readme.txt',
        mimetype: 'text/plain',
        size: buffer.length,
      });

      expect(result.extractedText).toBe(content);
    });

    it('should extract text from a JSON file', async () => {
      const jsonContent = JSON.stringify({ name: 'test', value: 42 });
      const buffer = Buffer.from(jsonContent);

      const result = await filesService.upload('org-1', {
        buffer,
        originalname: 'data.json',
        mimetype: 'application/json',
        size: buffer.length,
      });

      expect(result.extractedText).toBe(jsonContent);
    });

    it('should extract text from a markdown file', async () => {
      const mdContent = '# Title\n\nSome paragraph text.';
      const buffer = Buffer.from(mdContent);

      const result = await filesService.upload('org-1', {
        buffer,
        originalname: 'notes.md',
        mimetype: 'text/markdown',
        size: buffer.length,
      });

      expect(result.extractedText).toBe(mdContent);
    });

    it('should NOT extract text from a binary file (image)', async () => {
      // Create a fake PNG header
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

      const result = await filesService.upload('org-1', {
        buffer,
        originalname: 'photo.png',
        mimetype: 'image/png',
        size: buffer.length,
      });

      expect(result.extractedText).toBeNull();
    });

    it('should skip text extraction when extractText is false', async () => {
      const content = 'This should NOT be extracted.';
      const buffer = Buffer.from(content);

      const result = await filesService.upload('org-1', {
        buffer,
        originalname: 'skip.txt',
        mimetype: 'text/plain',
        size: buffer.length,
      }, { extractText: false });

      expect(result.extractedText).toBeNull();
    });

    it('should store file in agent-scoped subdirectory', async () => {
      const buffer = Buffer.from('agent file');

      const result = await filesService.upload('org-1', {
        buffer,
        originalname: 'agent-doc.txt',
        mimetype: 'text/plain',
        size: buffer.length,
      }, { agentId: 'agent-xyz' });

      expect(result.storageKey).toContain('agent-xyz');
      expect(result.agentId).toBe('agent-xyz');
    });
  });

  describe('download', () => {
    it('should download a previously uploaded file with matching content', async () => {
      const originalContent = 'Download me! This is the original file content.';
      const buffer = Buffer.from(originalContent);

      const uploaded = await filesService.upload('org-1', {
        buffer,
        originalname: 'download-test.txt',
        mimetype: 'text/plain',
        size: buffer.length,
      });

      const { buffer: downloadedBuffer, file } = await filesService.download(uploaded.id, 'org-1');

      expect(downloadedBuffer.toString('utf-8')).toBe(originalContent);
      expect(file.name).toBe('download-test.txt');
    });
  });

  describe('delete', () => {
    it('should delete a file from disk and the store', async () => {
      const buffer = Buffer.from('delete me');

      const uploaded = await filesService.upload('org-1', {
        buffer,
        originalname: 'to-delete.txt',
        mimetype: 'text/plain',
        size: buffer.length,
      });

      const filePath = path.join(tmpDir, uploaded.storageKey);
      expect(fs.existsSync(filePath)).toBe(true);

      await filesService.remove(uploaded.id, 'org-1');

      // File should be gone from disk
      expect(fs.existsSync(filePath)).toBe(false);
      // File should be gone from the store
      expect(fileStore.find(f => f.id === uploaded.id)).toBeUndefined();
    });
  });

  describe('findById', () => {
    it('should throw NotFoundException for non-existent file', async () => {
      await expect(
        filesService.findById('non-existent-id', 'org-1'),
      ).rejects.toThrow('File not found');
    });
  });

  describe('StorageService (direct local provider tests)', () => {
    it('should upload and download matching content', async () => {
      const key = 'test-org/general/some-file.txt';
      const data = Buffer.from('raw file data for direct storage test');

      const url = await storageService.upload(key, data, 'text/plain');
      expect(url).toContain('/files/');

      const downloaded = await storageService.download(key);
      expect(downloaded.toString('utf-8')).toBe('raw file data for direct storage test');
    });

    it('should delete a file from storage', async () => {
      const key = 'test-org/general/delete-me.txt';
      await storageService.upload(key, Buffer.from('bye'), 'text/plain');

      const filePath = path.join(tmpDir, key);
      expect(fs.existsSync(filePath)).toBe(true);

      await storageService.delete(key);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should handle deleting a non-existent file gracefully', async () => {
      // Should not throw
      await expect(
        storageService.delete('non/existent/file.txt'),
      ).resolves.toBeUndefined();
    });

    it('should return a signed URL (local fallback)', async () => {
      const key = 'test-org/general/url-test.txt';
      await storageService.upload(key, Buffer.from('url test'), 'text/plain');

      const signedUrl = await storageService.getSignedUrl(key);
      expect(signedUrl).toContain(key);
      expect(signedUrl).toContain('/download');
    });
  });

  describe('TextExtractorService (direct tests)', () => {
    it('should extract text from text/plain', async () => {
      const result = await textExtractor.extract(Buffer.from('hello world'), 'text/plain', 'test.txt');
      expect(result).toBe('hello world');
    });

    it('should extract text from text/csv', async () => {
      const csv = 'name,age\nAlice,30\nBob,25';
      const result = await textExtractor.extract(Buffer.from(csv), 'text/csv', 'data.csv');
      expect(result).toBe(csv);
    });

    it('should extract text from application/json', async () => {
      const json = '{"key": "value"}';
      const result = await textExtractor.extract(Buffer.from(json), 'application/json', 'data.json');
      expect(result).toBe(json);
    });

    it('should extract text from .yaml file extension', async () => {
      const yaml = 'key: value\nlist:\n  - item1';
      const result = await textExtractor.extract(Buffer.from(yaml), 'application/octet-stream', 'config.yaml');
      expect(result).toBe(yaml);
    });

    it('should return null for image/png', async () => {
      const result = await textExtractor.extract(Buffer.from([0x89, 0x50]), 'image/png', 'photo.png');
      expect(result).toBeNull();
    });

    it('should return null for application/pdf', async () => {
      const result = await textExtractor.extract(Buffer.from('%PDF'), 'application/pdf', 'doc.pdf');
      expect(result).toBeNull();
    });
  });
});
