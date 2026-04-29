/**
 * Vertex Memory Bank backend adapter tests. Mocks google-auth-library
 * + the underlying axios HTTP calls (Memory Bank has no typed JS
 * SDK), and asserts our :generateMemories / :retrieveMemories
 * shapes are right.
 */
import { v7 as uuidv7 } from 'uuid';

const axiosInstance = {
  post: jest.fn(),
};

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn().mockReturnValue(axiosInstance) },
}));

const fakeAuthClient = { getAccessToken: jest.fn(), credentials: { expiry_date: Date.now() + 3_600_000 } };
const googleAuthMock = {
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue(fakeAuthClient),
  })),
  JWT: class {},
  OAuth2Client: class {},
};
jest.mock('google-auth-library', () => googleAuthMock);

import { VertexMemoryBankBackend } from '../vertex-memory-bank.backend';
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
    content: 'team uses GraphQL',
    content_format: 'text',
    content_bytes: 16,
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

describe('VertexMemoryBankBackend (auth-mocked)', () => {
  let backend: VertexMemoryBankBackend;
  const credsBearer = {
    bearer: 'ya29.test',
    engine: 'projects/p/locations/us-central1/reasoningEngines/123',
    location: 'us-central1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    axiosInstance.post.mockReset();
    backend = new VertexMemoryBankBackend();
  });

  it('returns no_credentials when engine + bearer are absent', async () => {
    const h = await backend.healthCheck({});
    expect(h.ok).toBe(false);
    expect(h.details?.error).toBe('no_credentials');
  });

  it('healthCheck issues retrieveMemories on the engine path', async () => {
    axiosInstance.post.mockResolvedValue({ data: { retrievedMemories: [] } });
    const h = await backend.healthCheck(credsBearer);
    expect(h.ok).toBe(true);
    expect(axiosInstance.post).toHaveBeenCalledWith(
      `/v1beta1/${credsBearer.engine}:retrieveMemories`,
      expect.objectContaining({
        scope: { user_id: '__healthcheck__' },
        similaritySearchParams: { searchQuery: 'health', topK: 1 },
      }),
    );
  });

  it('put posts directContentsSource shape with scoped userId', async () => {
    axiosInstance.post.mockResolvedValue({ data: {} });
    const item = makeItem({ scope_id: 'org42', content: 'hello' });
    await backend.put(item, credsBearer);
    expect(axiosInstance.post).toHaveBeenCalledWith(
      `/v1beta1/${credsBearer.engine}:generateMemories`,
      expect.objectContaining({
        scope: { user_id: 'workspace_org42' },
        directContentsSource: {
          events: [{ content: { role: 'user', parts: [{ text: 'hello' }] } }],
        },
      }),
    );
  });

  it('search returns RankedItems mapped from retrievedMemories', async () => {
    axiosInstance.post.mockResolvedValue({
      data: {
        retrievedMemories: [
          { memory: { fact: 'GraphQL on frontend', name: 'reasoningEngines/123/memories/abc', metadata: {} }, distance: 0.3 },
        ],
      },
    });
    const ranked = await backend.search(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, query: 'frontend', top_k: 5 },
      credsBearer,
    );
    expect(axiosInstance.post).toHaveBeenCalledWith(
      `/v1beta1/${credsBearer.engine}:retrieveMemories`,
      expect.objectContaining({
        scope: { user_id: 'workspace_wks_test' },
        similaritySearchParams: { searchQuery: 'frontend', topK: 5 },
      }),
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].item.content).toBe('GraphQL on frontend');
    expect(ranked[0].score).toBeCloseTo(0.7, 5);
  });

  it('mints a bearer via google-auth when serviceAccountJson is provided', async () => {
    fakeAuthClient.getAccessToken.mockResolvedValue('minted-token');
    axiosInstance.post.mockResolvedValue({ data: { retrievedMemories: [] } });
    const credsSA = {
      engine: credsBearer.engine, location: 'us-central1',
      serviceAccountJson: { client_email: 'sa@p.iam', private_key_id: 'kid1', private_key: '-----' },
    };
    const h = await backend.healthCheck(credsSA);
    expect(h.ok).toBe(true);
    expect(googleAuthMock.GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
      credentials: credsSA.serviceAccountJson,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    }));
    expect(fakeAuthClient.getAccessToken).toHaveBeenCalled();
  });

  it('delete returns false (Memory Bank has no per-item delete)', async () => {
    const ok = await backend.delete('any-id', 'hard', credsBearer);
    expect(ok).toBe(false);
  });

  it('batchDelete returns failures for every id (no per-item delete)', async () => {
    const res = await backend.batchDelete(['a', 'b']);
    expect(res.failed).toBe(2);
    expect(res.errors).toHaveLength(2);
  });
});
