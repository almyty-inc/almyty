/**
 * Mem0 backend adapter tests. Mocks the official `mem0ai`
 * MemoryClient and asserts our toCanonical / fromCanonical /
 * dispatch shapes are correct. Trusting the SDK to be tested
 * means we only test our translation glue.
 */
import { v7 as uuidv7 } from 'uuid';

const mockClient = {
  ping: jest.fn().mockResolvedValue(undefined),
  add: jest.fn(),
  search: jest.fn(),
  getAll: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
  batchDelete: jest.fn(),
};

class FakeMemoryNotFoundError extends Error {}

jest.mock('mem0ai', () => ({
  __esModule: true,
  MemoryClient: jest.fn().mockImplementation(() => mockClient),
  MemoryNotFoundError: FakeMemoryNotFoundError,
}));

import { Mem0Backend } from '../mem0.backend';
import { MemoryItem, Provenance } from '../../canonical.types';

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
    scope_id: 'wks_test',
    content: 'Pluto is a dwarf planet.',
    content_format: 'text',
    content_bytes: 24,
    embedding: null, embedding_dim: null, embedding_model: null,
    embedding_status: 'skipped', embedding_error: null,
    tags: ['astro'], metadata: {}, file_refs: [],
    tier: 'long',
    valid_from: now, valid_until: null, superseded_by: null, ttl_seconds: null,
    source_uri: null, source_version: null, source_checksum: null,
    chunk_index: null, chunk_total: null, chunk_of: null,
    confidence: 1, provenance: baseProvenance,
    created_at: now, updated_at: now,
    accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    ...overrides,
  };
}

describe('Mem0Backend (SDK-mocked)', () => {
  let backend: Mem0Backend;
  const creds = { apiKey: 'test-key' };

  beforeEach(() => {
    jest.clearAllMocks();
    backend = new Mem0Backend();
  });

  it('healthCheck calls client.ping and returns ok=true on success', async () => {
    const h = await backend.healthCheck(creds);
    expect(h.ok).toBe(true);
    expect(mockClient.ping).toHaveBeenCalled();
  });

  it('healthCheck returns ok=false with no creds', async () => {
    const h = await backend.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.details?.error).toBe('no_credentials');
  });

  it('put translates MemoryItem to client.add with userId and metadata', async () => {
    mockClient.add.mockResolvedValue([{ id: 'mem0-id-1', metadata: {} }]);
    const item = makeItem({ scope_id: 'org42', content: 'hello' });
    await backend.put(item, creds);
    expect(mockClient.add).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hello' }],
      expect.objectContaining({
        userId: 'workspace:org42',
        metadata: expect.objectContaining({
          almyty_id: item.id,
          scope_type: 'workspace',
          scope_id: 'org42',
          tier: 'long',
          tags: ['astro'],
        }),
      }),
    );
  });

  it('search calls client.search with userId filter and topK and returns RankedItems', async () => {
    mockClient.search.mockResolvedValue({
      results: [{ id: 'r1', memory: 'fact', score: 0.9, metadata: { almyty_id: 'a1' } }],
    });
    const ranked = await backend.search(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, query: 'pluto', top_k: 3 },
      creds,
    );
    expect(mockClient.search).toHaveBeenCalledWith('pluto', {
      filters: { user_id: 'workspace:wks_test' },
      topK: 3,
    });
    expect(ranked[0].score).toBe(0.9);
    expect(ranked[0].item.content).toBe('fact');
    expect(ranked[0].signal).toBe('vector');
  });

  it('list returns paginated MemoryItems and forwards cursor', async () => {
    mockClient.getAll.mockResolvedValue({
      results: [{ id: 'r1', memory: 'one', metadata: {} }],
      count: 1,
      next: null,
    });
    const page = await backend.list(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, limit: 10 },
      creds,
    );
    expect(mockClient.getAll).toHaveBeenCalledWith({
      filters: { user_id: 'workspace:wks_test' },
      pageSize: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it('get returns null on MemoryNotFoundError', async () => {
    mockClient.get.mockRejectedValue(new FakeMemoryNotFoundError('nope'));
    const item = await backend.get('missing', creds);
    expect(item).toBeNull();
  });

  it('batchDelete delegates to client.batchDelete in one call', async () => {
    mockClient.batchDelete.mockResolvedValue('ok');
    const res = await backend.batchDelete(['a', 'b', 'c'], creds);
    expect(mockClient.batchDelete).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(res.succeeded).toBe(3);
  });

  it('toCanonical preserves almyty_id from metadata when present', () => {
    const raw = {
      id: 'mem0-internal',
      memory: 'content',
      metadata: { almyty_id: 'almyty-uuid', scope_type: 'workspace', scope_id: 'x', tier: 'short' },
    };
    const item = backend.toCanonical(raw);
    expect(item.id).toBe('almyty-uuid');
    expect(item.scope_id).toBe('x');
    expect(item.tier).toBe('short');
  });
});
