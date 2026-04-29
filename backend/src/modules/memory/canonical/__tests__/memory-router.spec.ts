/**
 * MemoryRouter unit tests. Exercises the routing decision matrix +
 * capability gating + transfer warnings. Backends are stand-ins
 * implementing the MemoryBackend interface — these tests don't hit
 * any external service, so they run in every CI lane.
 *
 * The external-backend integration suite covers the real-network
 * round-trip per backend.
 */
import { v7 as uuidv7 } from 'uuid';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CanonicalMemoryWorkspaceConfig } from '../canonical-memory-config.entity';
import { MemoryRouter } from '../memory-router.service';
import { AlmytyNativeBackend } from '../backends/almyty-native.backend';
import { AnthropicMemoryToolBackend } from '../backends/anthropic-memory-tool.backend';
import { Mem0Backend } from '../backends/mem0.backend';
import { ZepBackend } from '../backends/zep.backend';
import { SupermemoryBackend } from '../backends/supermemory.backend';
import { VertexMemoryBankBackend } from '../backends/vertex-memory-bank.backend';
import { MemoryBackend, BackendHealth } from '../backends/memory-backend.interface';
import { Capability, MemoryError, MemoryItem, Mode, Provenance } from '../canonical.types';
import { AuditLogService } from '../../../audit-log/audit-log.service';

const baseProvenance: Provenance = {
  agent_id: null, session_id: null, collab_id: null,
  model: null, provider: null, tool_chain: [],
  created_by: 'agent', source_backend: 'almyty-native',
};

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date();
  return {
    id: uuidv7(),
    mode: 'memory',
    scope_type: 'workspace',
    scope_id: 'wks_router',
    content: 'router test',
    content_format: 'text',
    content_bytes: 11,
    embedding: null, embedding_dim: null, embedding_model: null,
    embedding_status: 'pending', embedding_error: null,
    tags: [], metadata: {}, file_refs: [],
    tier: 'short',
    valid_from: now, valid_until: null, superseded_by: null, ttl_seconds: null,
    source_uri: null, source_version: null, source_checksum: null,
    chunk_index: null, chunk_total: null, chunk_of: null,
    confidence: 1, provenance: baseProvenance,
    created_at: now, updated_at: now,
    accessed_at: null, access_count: 0,
    deleted_at: null, deleted_by: null,
    ...overrides,
  };
}

class FakeBackend implements MemoryBackend {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly supported_modes: ReadonlySet<Mode>;
  put = jest.fn(async (item: MemoryItem) => item);
  get = jest.fn(async (_id: string) => null as MemoryItem | null);
  delete = jest.fn(async (_id: string, _mode?: 'soft' | 'hard') => true);
  list = jest.fn(async () => ({ items: [] as MemoryItem[], total: 0, cursor: null as string | null }));
  search = jest.fn(async () => [] as any[]);
  supersede = jest.fn(async () => { throw new Error('not supported'); });
  asOf = jest.fn(async () => { throw new Error('not supported'); });
  batchPut = jest.fn(async (items: MemoryItem[]) => ({ succeeded: items.length, failed: 0, errors: [] }));
  batchDelete = jest.fn(async (ids: string[]) => ({ succeeded: ids.length, failed: 0, errors: [] }));
  toCanonical = jest.fn((raw: unknown) => raw as MemoryItem);
  fromCanonical = jest.fn((item: MemoryItem) => item as unknown);
  init = jest.fn(async () => {});
  healthCheck = jest.fn(async (): Promise<BackendHealth> => ({ ok: true, latency_ms: 1 }));

  constructor(id: string, caps: Capability[], modes: Mode[]) {
    this.id = id;
    this.capabilities = new Set(caps);
    this.supported_modes = new Set(modes);
  }
}

describe('MemoryRouter', () => {
  let router: MemoryRouter;
  let configRepo: any;
  let native: FakeBackend;
  let mem0: FakeBackend;
  let zep: FakeBackend;
  let supermemory: FakeBackend;
  let anthropic: FakeBackend;
  let vertex: FakeBackend;

  beforeEach(async () => {
    native = new FakeBackend(
      'almyty-native',
      ['mode_memory', 'mode_document', 'vector_search', 'fts', 'hybrid_search', 'bi_temporal', 'ttl', 'soft_delete', 'as_of_queries'],
      ['memory', 'document'],
    );
    mem0 = new FakeBackend('mem0', ['mode_memory', 'vector_search'], ['memory']);
    zep = new FakeBackend('zep', ['mode_memory', 'vector_search', 'graph_search', 'bi_temporal'], ['memory']);
    supermemory = new FakeBackend('supermemory', ['mode_memory', 'mode_document', 'vector_search', 'fts'], ['memory', 'document']);
    anthropic = new FakeBackend('anthropic-memory-tool', ['mode_memory', 'vector_search'], ['memory']);
    vertex = new FakeBackend('vertex-memory-bank', ['mode_memory', 'vector_search', 'change_feed'], ['memory']);

    configRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const auditStub = { log: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MemoryRouter,
        { provide: getRepositoryToken(CanonicalMemoryWorkspaceConfig), useValue: configRepo },
        { provide: AuditLogService, useValue: auditStub },
        { provide: AlmytyNativeBackend, useValue: native },
        { provide: AnthropicMemoryToolBackend, useValue: anthropic },
        { provide: Mem0Backend, useValue: mem0 },
        { provide: ZepBackend, useValue: zep },
        { provide: SupermemoryBackend, useValue: supermemory },
        { provide: VertexMemoryBankBackend, useValue: vertex },
      ],
    }).compile();
    router = moduleRef.get(MemoryRouter);
    await router.onModuleInit();
  });

  describe('selection', () => {
    it('defaults to native when no scope override exists', async () => {
      const item = makeItem();
      await router.put(item);
      expect(native.put).toHaveBeenCalled();
      expect(mem0.put).not.toHaveBeenCalled();
    });

    it('routes to the configured backend when overrides specify one', async () => {
      configRepo.findOne.mockResolvedValueOnce({
        scopeType: 'workspace', scopeId: 'wks_router',
        embeddingDim: 1536, embeddingModel: 'm', embeddingProvider: 'p',
        softcapBehavior: 'warn_log',
        overrides: { routing: { memory_backend: 'mem0' } },
      });
      await router.put(makeItem());
      expect(mem0.put).toHaveBeenCalled();
      expect(native.put).not.toHaveBeenCalled();
    });

    it('falls back to native when the configured backend does not support the requested mode', async () => {
      configRepo.findOne.mockResolvedValueOnce({
        scopeType: 'workspace', scopeId: 'wks_router',
        embeddingDim: 1536, embeddingModel: 'm', embeddingProvider: 'p',
        softcapBehavior: 'warn_log',
        overrides: { routing: { document_backend: 'mem0' } }, // mem0 is memory-only
      });
      await router.list({ scope: { scope_type: 'workspace', scope_id: 'wks_router' }, mode: 'document' });
      expect(native.list).toHaveBeenCalled();
      expect(mem0.list).not.toHaveBeenCalled();
    });

    it('mirrors a put when overrides specify a mirror_backend', async () => {
      configRepo.findOne.mockResolvedValue({
        scopeType: 'workspace', scopeId: 'wks_router',
        embeddingDim: 1536, embeddingModel: 'm', embeddingProvider: 'p',
        softcapBehavior: 'warn_log',
        overrides: { routing: { memory_backend: 'almyty-native', mirror_backend: 'mem0' } },
      });
      const item = makeItem();
      await router.put(item);
      expect(native.put).toHaveBeenCalledWith(item);
      // Mirror is fire-and-forget; allow microtask to flush.
      await new Promise((r) => setImmediate(r));
      expect(mem0.put).toHaveBeenCalledWith(item);
    });
  });

  describe('capability gating', () => {
    it('throws unsupported_capability when calling supersede on a non-bi-temporal backend', async () => {
      configRepo.findOne.mockResolvedValueOnce({
        scopeType: 'workspace', scopeId: 'wks_router',
        embeddingDim: 1536, embeddingModel: 'm', embeddingProvider: 'p',
        softcapBehavior: 'warn_log',
        overrides: { routing: { memory_backend: 'mem0' } },
      });
      await expect(
        router.supersede(
          { scope_type: 'workspace', scope_id: 'wks_router' },
          'old-id',
          makeItem(),
        ),
      ).rejects.toBeInstanceOf(MemoryError);
    });

    it('throws unsupported_capability when calling search on a non-vector_search backend (hypothetical)', async () => {
      // Add a backend with no vector_search capability.
      (router as any).backends.set(
        'no-vec',
        new FakeBackend('no-vec', ['mode_memory'], ['memory']),
      );
      configRepo.findOne.mockResolvedValueOnce({
        scopeType: 'workspace', scopeId: 'wks_router',
        embeddingDim: 1536, embeddingModel: 'm', embeddingProvider: 'p',
        softcapBehavior: 'warn_log',
        overrides: { routing: { memory_backend: 'no-vec' } },
      });
      await expect(
        router.search({ scope: { scope_type: 'workspace', scope_id: 'wks_router' }, query: 'hi' }),
      ).rejects.toBeInstanceOf(MemoryError);
    });
  });

  describe('transfer warnings', () => {
    it('flags bi_temporal loss when transferring native → mem0', async () => {
      const items = [
        makeItem({ valid_until: new Date(), superseded_by: uuidv7() }),
        makeItem({ ttl_seconds: 60 }),
        makeItem({ valid_until: null, superseded_by: null, ttl_seconds: null }),
      ];
      native.list.mockResolvedValueOnce({ items, total: items.length, cursor: null });
      const report = await router.transfer(
        { scope_type: 'workspace', scope_id: 'wks_router' },
        'almyty-native',
        'mem0',
        { dry_run: true },
      );
      expect(report.warnings.find((w) => w.capability === 'bi_temporal' && w.field === 'valid_until')?.count).toBe(1);
      expect(report.warnings.find((w) => w.capability === 'bi_temporal' && w.field === 'superseded_by')?.count).toBe(1);
      expect(report.warnings.find((w) => w.capability === 'ttl')?.count).toBe(1);
      expect(report.total_source).toBe(3);
      // dry_run skips the actual write
      expect(mem0.batchPut).not.toHaveBeenCalled();
    });

    it('runs a real transfer when dry_run is false', async () => {
      const items = [makeItem(), makeItem()];
      native.list.mockResolvedValueOnce({ items, total: items.length, cursor: null });
      const report = await router.transfer(
        { scope_type: 'workspace', scope_id: 'wks_router' },
        'almyty-native',
        'mem0',
      );
      expect(mem0.batchPut).toHaveBeenCalledWith(items);
      expect(report.succeeded).toBe(2);
    });
  });

  describe('listing + health', () => {
    it('list_backends returns every registered backend with capabilities and modes', () => {
      const list = router.list_backends();
      const ids = list.map((l) => l.id).sort();
      expect(ids).toEqual([
        'almyty-native',
        'anthropic-memory-tool',
        'mem0',
        'supermemory',
        'vertex-memory-bank',
        'zep',
      ]);
    });

    it('healthAll returns one entry per backend', async () => {
      const result = await router.healthAll();
      expect(Object.keys(result).sort()).toEqual([
        'almyty-native', 'anthropic-memory-tool', 'mem0', 'supermemory', 'vertex-memory-bank', 'zep',
      ]);
    });
  });
});
