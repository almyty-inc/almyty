import { v7 as uuidv7 } from 'uuid';
import { validateMemoryItem } from '../canonical.validator';
import { MemoryItem, Provenance } from '../canonical.types';

const baseProvenance: Provenance = {
  agent_id: null,
  session_id: null,
  collab_id: null,
  model: null,
  provider: null,
  tool_chain: [],
  created_by: 'agent',
  source_backend: 'almyty-native',
};

function memoryRow(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date();
  const base: MemoryItem = {
    id: uuidv7(),
    mode: 'memory',
    scope_type: 'workspace',
    scope_id: 'wks_1',
    content: 'hello world',
    content_format: 'text',
    content_bytes: 11,
    embedding: null,
    embedding_dim: null,
    embedding_model: null,
    embedding_status: 'pending',
    embedding_error: null,
    tags: [],
    metadata: {},
    file_refs: [],
    tier: 'short',
    valid_from: now,
    valid_until: null,
    superseded_by: null,
    ttl_seconds: null,
    source_uri: null,
    source_version: null,
    source_checksum: null,
    chunk_index: null,
    chunk_total: null,
    chunk_of: null,
    confidence: 1,
    provenance: baseProvenance,
    created_at: now,
    updated_at: now,
    accessed_at: null,
    access_count: 0,
    deleted_at: null,
    deleted_by: null,
  };
  return { ...base, ...overrides };
}

function documentRow(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date();
  return {
    ...memoryRow(),
    mode: 'document',
    tier: null,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    ttl_seconds: null,
    source_uri: 'almyty:file/abc',
    source_version: 1,
    source_checksum: 'sha256:deadbeef',
    chunk_index: 0,
    chunk_total: 4,
    chunk_of: uuidv7(),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('validateMemoryItem', () => {
  describe('happy paths', () => {
    it('accepts a minimal valid memory-mode item', () => {
      expect(validateMemoryItem(memoryRow())).toEqual([]);
    });
    it('accepts a minimal valid document-mode item', () => {
      expect(validateMemoryItem(documentRow())).toEqual([]);
    });
    it('accepts a memory-mode item with a ready embedding of matching dim', () => {
      const item = memoryRow({
        embedding: new Array(1536).fill(0.1),
        embedding_dim: 1536,
        embedding_model: 'text-embedding-3-small',
        embedding_status: 'ready',
      });
      expect(validateMemoryItem(item)).toEqual([]);
    });
  });

  describe('mode invariants — memory mode', () => {
    it('rejects when tier is null', () => {
      const issues = validateMemoryItem(memoryRow({ tier: null }));
      expect(issues.find((i) => i.path === 'tier')).toBeDefined();
    });
    it('rejects when valid_from is null', () => {
      const issues = validateMemoryItem(memoryRow({ valid_from: null }));
      expect(issues.find((i) => i.path === 'valid_from')).toBeDefined();
    });
    it('rejects when source_uri is set on memory mode', () => {
      const issues = validateMemoryItem(memoryRow({ source_uri: 'almyty:file/x' }));
      expect(issues.find((i) => i.path === 'source_uri')).toBeDefined();
    });
    it('rejects when chunk_of is set on memory mode', () => {
      const issues = validateMemoryItem(memoryRow({ chunk_of: uuidv7() }));
      expect(issues.find((i) => i.path === 'chunk_of')).toBeDefined();
    });
  });

  describe('mode invariants — document mode', () => {
    it('rejects when source_uri is null', () => {
      const issues = validateMemoryItem(documentRow({ source_uri: null }));
      expect(issues.find((i) => i.path === 'source_uri')).toBeDefined();
    });
    it('rejects when source_version is null', () => {
      const issues = validateMemoryItem(documentRow({ source_version: null }));
      expect(issues.find((i) => i.path === 'source_version')).toBeDefined();
    });
    it('rejects when tier is set', () => {
      const issues = validateMemoryItem(documentRow({ tier: 'short' }));
      expect(issues.find((i) => i.path === 'tier')).toBeDefined();
    });
    it('rejects ttl_seconds on document mode', () => {
      const issues = validateMemoryItem(documentRow({ ttl_seconds: 60 }));
      expect(issues.find((i) => i.path === 'ttl_seconds')).toBeDefined();
    });
    it('rejects superseded_by on document mode', () => {
      const issues = validateMemoryItem(documentRow({ superseded_by: uuidv7() }));
      // superseded_by triggers two issues: forbidden in document mode
      // AND requires valid_until. Either is enough to assert mode rule.
      expect(issues.find((i) => i.path === 'superseded_by')).toBeDefined();
    });
  });

  describe('bi-temporal sanity', () => {
    it('rejects valid_until < valid_from', () => {
      const item = memoryRow({
        valid_from: new Date('2026-01-02'),
        valid_until: new Date('2026-01-01'),
      });
      expect(validateMemoryItem(item).find((i) => i.path === 'valid_until')).toBeDefined();
    });
    it('accepts valid_until == valid_from', () => {
      const t = new Date();
      expect(
        validateMemoryItem(memoryRow({ valid_from: t, valid_until: t })),
      ).toEqual([]);
    });
    it('rejects superseded_by without valid_until', () => {
      const item = memoryRow({ superseded_by: uuidv7(), valid_until: null });
      expect(
        validateMemoryItem(item).find(
          (i) => i.path === 'superseded_by' && /requires valid_until/.test(i.message),
        ),
      ).toBeDefined();
    });
  });

  describe('embedding consistency', () => {
    it('rejects non-null embedding without embedding_dim', () => {
      const item = memoryRow({
        embedding: [0.1, 0.2],
        embedding_dim: null,
        embedding_status: 'ready',
      });
      expect(
        validateMemoryItem(item).find((i) => i.path === 'embedding_dim'),
      ).toBeDefined();
    });
    it('rejects embedding length mismatch with embedding_dim', () => {
      // 64 is EMBEDDING_MIN_DIM — pass basic-shape so we can hit the
      // cross-field length check.
      const item = memoryRow({
        embedding: new Array(63).fill(0.1),
        embedding_dim: 64,
        embedding_status: 'ready',
      });
      expect(validateMemoryItem(item).find((i) => i.path === 'embedding')).toBeDefined();
    });
    it('rejects non-null embedding when status != ready', () => {
      const item = memoryRow({
        embedding: new Array(64).fill(0.1),
        embedding_dim: 64,
        embedding_status: 'pending',
      });
      expect(
        validateMemoryItem(item).find((i) => i.path === 'embedding_status'),
      ).toBeDefined();
    });
    it('rejects failed status without embedding_error', () => {
      const item = memoryRow({
        embedding_status: 'failed',
        embedding_error: null,
      });
      expect(
        validateMemoryItem(item).find((i) => i.path === 'embedding_error'),
      ).toBeDefined();
    });
  });

  describe('chunk consistency', () => {
    it('rejects chunk_index without chunk_total', () => {
      const item = documentRow({ chunk_index: 0, chunk_total: null });
      expect(
        validateMemoryItem(item).find((i) => i.path === 'chunk_total'),
      ).toBeDefined();
    });
    it('rejects chunk_index >= chunk_total', () => {
      const item = documentRow({ chunk_index: 4, chunk_total: 4 });
      expect(
        validateMemoryItem(item).find((i) => i.path === 'chunk_index'),
      ).toBeDefined();
    });
  });

  describe('provenance', () => {
    it('rejects missing provenance', () => {
      const item = { ...memoryRow(), provenance: undefined as unknown as Provenance };
      expect(validateMemoryItem(item).find((i) => i.path === 'provenance')).toBeDefined();
    });
    it('rejects unknown created_by', () => {
      const bad: any = memoryRow({
        provenance: { ...baseProvenance, created_by: 'someone' as any },
      });
      expect(
        validateMemoryItem(bad).find((i) => i.path === 'provenance.created_by'),
      ).toBeDefined();
    });
  });

  describe('basic shape', () => {
    it('rejects non-object input', () => {
      expect(validateMemoryItem(null).length).toBeGreaterThan(0);
      expect(validateMemoryItem('hi').length).toBeGreaterThan(0);
      expect(validateMemoryItem(42).length).toBeGreaterThan(0);
    });
    it('rejects empty content', () => {
      expect(
        validateMemoryItem(memoryRow({ content: '' })).find((i) => i.path === 'content'),
      ).toBeDefined();
    });
    it('rejects negative content_bytes', () => {
      expect(
        validateMemoryItem(memoryRow({ content_bytes: -1 })).find((i) => i.path === 'content_bytes'),
      ).toBeDefined();
    });
    it('rejects confidence out of [0,1]', () => {
      expect(
        validateMemoryItem(memoryRow({ confidence: 1.5 })).find((i) => i.path === 'confidence'),
      ).toBeDefined();
      expect(
        validateMemoryItem(memoryRow({ confidence: -0.1 })).find((i) => i.path === 'confidence'),
      ).toBeDefined();
    });
    it('rejects malformed UUID id', () => {
      expect(
        validateMemoryItem(memoryRow({ id: 'not-a-uuid' })).find((i) => i.path === 'id'),
      ).toBeDefined();
    });
  });
});
