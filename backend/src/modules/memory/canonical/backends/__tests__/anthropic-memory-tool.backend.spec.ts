/**
 * Anthropic Memory Tool backend adapter tests. Mocks Anthropic
 * SDK's beta.files API and asserts our translation glue.
 */
import { v7 as uuidv7 } from 'uuid';

const mockClient = {
  beta: {
    files: {
      list: jest.fn(),
      upload: jest.fn(),
      download: jest.fn(),
      retrieveMetadata: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
  },
};

class FakeNotFoundError extends Error {}

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockClient),
  toFile: jest.fn().mockImplementation(async (buf, name, opts) => ({
    __isFile: true, name, type: opts?.type, size: (buf as Buffer).length,
  })),
  NotFoundError: FakeNotFoundError,
}));

import { AnthropicMemoryToolBackend } from '../anthropic-memory-tool.backend';
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
    content: 'user prefers terse responses',
    content_format: 'text',
    content_bytes: 28,
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

describe('AnthropicMemoryToolBackend (SDK-mocked)', () => {
  let backend: AnthropicMemoryToolBackend;
  const creds = { apiKey: 'sk-ant-test' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.beta.files.delete.mockResolvedValue({});
    backend = new AnthropicMemoryToolBackend();
  });

  it('healthCheck calls beta.files.list with the files-api beta header', async () => {
    mockClient.beta.files.list.mockResolvedValue({ data: [] });
    const h = await backend.healthCheck(creds);
    expect(h.ok).toBe(true);
    expect(mockClient.beta.files.list).toHaveBeenCalledWith({
      limit: 1, betas: ['files-api-2025-04-14'],
    });
  });

  it('put uploads via beta.files.upload with a scoped filename', async () => {
    mockClient.beta.files.upload.mockResolvedValue({ id: 'file_abc' });
    const item = makeItem({ scope_id: 'org42', content: 'hello' });
    const res = await backend.put(item, creds);
    expect(mockClient.beta.files.upload).toHaveBeenCalledWith(
      { file: expect.objectContaining({ __isFile: true, type: 'text/markdown' }), betas: ['files-api-2025-04-14'] },
    );
    expect((res.metadata as any).anthropic_file_id).toBe('file_abc');
  });

  it('list filters by scope prefix and downloads each match', async () => {
    const fakePager = (async function* () {
      yield { id: 'f1', filename: 'workspace_wks_test__abc.md', created_at: '2026-01-01T00:00:00Z' };
      yield { id: 'f2', filename: 'workspace_other__zzz.md' };
    })();
    mockClient.beta.files.list.mockResolvedValue(fakePager);
    mockClient.beta.files.download.mockResolvedValue({ text: async () => 'body' });

    const page = await backend.list(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, limit: 100 },
      creds,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].content).toBe('body');
    expect(mockClient.beta.files.download).toHaveBeenCalledTimes(1);
  });

  it('get returns null on NotFoundError', async () => {
    mockClient.beta.files.retrieveMetadata.mockRejectedValue(new FakeNotFoundError('nope'));
    const item = await backend.get('missing', creds);
    expect(item).toBeNull();
  });

  it('search filters list results by case-insensitive substring', async () => {
    const fakePager = (async function* () {
      yield { id: 'f1', filename: 'workspace_wks_test__a.md' };
      yield { id: 'f2', filename: 'workspace_wks_test__b.md' };
    })();
    mockClient.beta.files.list.mockResolvedValue(fakePager);
    const downloads = ['Pluto is a dwarf planet', 'Mars is red'];
    mockClient.beta.files.download.mockImplementation(async () => ({ text: async () => downloads.shift()! }));

    const ranked = await backend.search(
      { scope: { scope_type: 'workspace', scope_id: 'wks_test' }, query: 'dwarf', top_k: 5 },
      creds,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].item.content).toContain('dwarf');
  });

  it('toCanonical extracts almyty id from scoped filename', () => {
    const item = backend.toCanonical({
      id: 'file_x',
      filename: 'workspace_org9__01234567-89ab-cdef-0123-456789abcdef.md',
      _content: 'hello',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(item.scope_type).toBe('workspace');
    expect(item.scope_id).toBe('org9');
    expect(item.id).toBe('01234567-89ab-cdef-0123-456789abcdef');
  });
});
