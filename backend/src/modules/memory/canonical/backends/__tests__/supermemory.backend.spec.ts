/**
 * Supermemory backend adapter tests. Mocks the official `supermemory`
 * SDK and asserts our translation glue is correct.
 */
import { v7 as uuidv7 } from 'uuid';

const mockClient = {
  documents: {
    list: jest.fn(),
    add: jest.fn(),
    batchAdd: jest.fn(),
    get: jest.fn(),
    delete: jest.fn().mockResolvedValue({}),
    deleteBulk: jest.fn(),
  },
  search: {
    memories: jest.fn(),
  },
};

class FakeNotFoundError extends Error {}

jest.mock('supermemory', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockClient),
  NotFoundError: FakeNotFoundError,
}));

import { SupermemoryBackend } from '../supermemory.backend';
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
    content: 'pgvector adds vector search to postgres',
    content_format: 'text',
    content_bytes: 40,
    embedding: null, embedding_dim: null, embedding_model: null,
    embedding_status: 'skipped', embedding_error: null,
    tags: ['db'], metadata: {}, file_refs: [],
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

describe('SupermemoryBackend (SDK-mocked)', () => {
  let backend: SupermemoryBackend;
  const creds = { apiKey: 'sm-test' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.documents.delete.mockResolvedValue({});
    backend = new SupermemoryBackend();
  });

  it('healthCheck calls documents.list', async () => {
    mockClient.documents.list.mockResolvedValue({ memories: [], pagination: { totalItems: 0 } });
    const h = await backend.healthCheck(creds);
    expect(h.ok).toBe(true);
    expect(mockClient.documents.list).toHaveBeenCalledWith({ limit: 1 });
  });

  it('put calls documents.add with containerTag, customId, flattened metadata (provenance_json)', async () => {
    mockClient.documents.add.mockResolvedValue({ id: 'sm-1', status: 'queued' });
    const item = makeItem({ scope_id: 'wks_a', tier: 'short' });
    await backend.put(item, creds);
    const call = mockClient.documents.add.mock.calls[0][0];
    expect(call.containerTag).toBe('workspace_wks_a');
    expect(call.customId).toBe(item.id);
    expect(call.metadata.provenance_json).toBe(JSON.stringify(item.provenance));
    expect(call.metadata.tier).toBe('short');
    expect(typeof call.metadata.almyty_id).toBe('string');
  });

  it('search calls search.memories with containerTag and limit, returns RankedItems', async () => {
    mockClient.search.memories.mockResolvedValue({
      results: [{ id: 'r1', memory: 'fact', similarity: 0.7, metadata: { almyty_id: 'a1' }, updatedAt: '2026-01-01T00:00:00Z' }],
      timing: 10, total: 1,
    });
    const ranked = await backend.search(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, query: 'pgvector', top_k: 4 },
      creds,
    );
    expect(mockClient.search.memories).toHaveBeenCalledWith({
      q: 'pgvector', containerTag: 'workspace_wks_test', limit: 4,
    });
    expect(ranked[0].score).toBe(0.7);
    expect(ranked[0].signal).toBe('hybrid');
  });

  it('list calls documents.list with containerTag filter and includeContent', async () => {
    mockClient.documents.list.mockResolvedValue({
      memories: [{ id: 'd1', content: 'doc', metadata: {}, updatedAt: '2026-01-01T00:00:00Z' }],
      pagination: { totalItems: 1, currentPage: 1, totalPages: 1 },
    });
    const page = await backend.list(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, limit: 25 },
      creds,
    );
    expect(mockClient.documents.list).toHaveBeenCalledWith({
      filters: { OR: [{ key: 'containerTag', value: 'workspace_wks_test' }] },
      limit: 25, includeContent: true,
    });
    expect(page.total).toBe(1);
  });

  it('batchPut calls documents.batchAdd once and maps successes/failures', async () => {
    mockClient.documents.batchAdd.mockResolvedValue({
      success: 2, failed: 1,
      results: [
        { id: 'a', status: 'queued' },
        { id: '', status: 'error', error: 'bad' },
        { id: 'b', status: 'queued' },
      ],
    });
    const items = [makeItem(), makeItem(), makeItem()];
    const res = await backend.batchPut(items, creds);
    expect(mockClient.documents.batchAdd).toHaveBeenCalledTimes(1);
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.errors[0].id).toBe(items[1].id);
  });

  it('delete returns false on NotFoundError', async () => {
    mockClient.documents.delete.mockRejectedValue(new FakeNotFoundError('gone'));
    const ok = await backend.delete('x', 'hard', creds);
    expect(ok).toBe(false);
  });
});
