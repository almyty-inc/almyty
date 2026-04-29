/**
 * Zep backend adapter tests. Mocks ZepClient from
 * @getzep/zep-cloud and asserts our translation glue is correct.
 */
import { v7 as uuidv7 } from 'uuid';

const mockClient = {
  user: {
    add: jest.fn().mockResolvedValue({}),
    listOrdered: jest.fn().mockResolvedValue({}),
  },
  graph: {
    add: jest.fn().mockResolvedValue({}),
    search: jest.fn(),
    episode: {
      get: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      getByUserId: jest.fn(),
    },
  },
};

jest.mock('@getzep/zep-cloud', () => ({
  __esModule: true,
  Zep: {},
  ZepClient: jest.fn().mockImplementation(() => mockClient),
}));

import { ZepBackend } from '../zep.backend';
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
    content: 'user prefers dark mode',
    content_format: 'text',
    content_bytes: 22,
    embedding: null, embedding_dim: null, embedding_model: null,
    embedding_status: 'skipped', embedding_error: null,
    tags: [], metadata: {}, file_refs: [],
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

describe('ZepBackend (SDK-mocked)', () => {
  let backend: ZepBackend;
  const creds = { apiKey: 'zep-test' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.user.add.mockResolvedValue({});
    mockClient.graph.add.mockResolvedValue({});
    mockClient.graph.episode.delete.mockResolvedValue({});
    backend = new ZepBackend();
  });

  it('healthCheck calls user.listOrdered', async () => {
    mockClient.user.listOrdered.mockResolvedValue({ users: [] });
    const h = await backend.healthCheck(creds);
    expect(h.ok).toBe(true);
    expect(mockClient.user.listOrdered).toHaveBeenCalledWith({ pageSize: 1 });
  });

  it('put ensures user then calls graph.add with userId+data+type=message', async () => {
    const item = makeItem({ scope_id: 'org42', content: 'hello' });
    await backend.put(item, creds);
    expect(mockClient.user.add).toHaveBeenCalledWith({ userId: 'workspace_org42' });
    expect(mockClient.graph.add).toHaveBeenCalledWith({
      data: 'hello', type: 'message', userId: 'workspace_org42',
    });
  });

  it('put swallows 409 from user.add (existing user)', async () => {
    mockClient.user.add.mockRejectedValue({ statusCode: 409 });
    const item = makeItem();
    await expect(backend.put(item, creds)).resolves.not.toThrow();
    expect(mockClient.graph.add).toHaveBeenCalled();
  });

  it('search calls graph.search with userId+limit+scope=edges and maps to RankedItem', async () => {
    mockClient.graph.search.mockResolvedValue({
      edges: [{ uuid: 'e1', content: 'fact', score: 0.85, validAt: '2026-01-01T00:00:00Z' }],
    });
    const ranked = await backend.search(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, query: 'mode', top_k: 5 },
      creds,
    );
    expect(mockClient.graph.search).toHaveBeenCalledWith({
      query: 'mode', userId: 'workspace_wks_test', limit: 5, scope: 'edges',
    });
    expect(ranked[0].score).toBe(0.85);
    expect(ranked[0].item.content).toBe('fact');
  });

  it('list calls graph.episode.getByUserId with lastn', async () => {
    mockClient.graph.episode.getByUserId.mockResolvedValue({
      episodes: [{ uuid: 'ep1', content: 'msg', createdAt: '2026-01-01T00:00:00Z' }],
    });
    const page = await backend.list(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, limit: 7 },
      creds,
    );
    expect(mockClient.graph.episode.getByUserId).toHaveBeenCalledWith('workspace_wks_test', { lastn: 7 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].content).toBe('msg');
  });

  it('get returns null on 404', async () => {
    mockClient.graph.episode.get.mockRejectedValue({ statusCode: 404 });
    const item = await backend.get('missing', creds);
    expect(item).toBeNull();
  });

  it('toCanonical reads validAt as valid_from and invalidAt as valid_until', () => {
    const raw = {
      uuid: 'e1', content: 'fact',
      validAt: '2026-01-01T00:00:00Z', invalidAt: '2026-06-01T00:00:00Z',
      score: 0.5,
    };
    const item = backend.toCanonical(raw);
    expect(item.valid_from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(item.valid_until?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});
