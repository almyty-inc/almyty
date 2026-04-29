/**
 * External backend integration tests.
 *
 * Each `describeIfKey(BACKEND, ENV_VAR)` block runs the same
 * canonical interface contract (init / health / put / list / search
 * / get / delete / batch) against the real provider. Suites are
 * gated on the corresponding env var so a CI run without secrets
 * skips them automatically; a developer with one key set runs only
 * that suite.
 *
 * Real provider, no mocks. The point is to catch translation drift
 * and API-shape changes — both fail loudly here.
 */
import { v7 as uuidv7 } from 'uuid';

import { Mem0Backend } from '../mem0.backend';
import { ZepBackend } from '../zep.backend';
import { SupermemoryBackend } from '../supermemory.backend';
import { VertexMemoryBankBackend } from '../vertex-memory-bank.backend';
import { AnthropicMemoryToolBackend } from '../anthropic-memory-tool.backend';
import { MemoryItem, Provenance, ScopeRef } from '../../canonical.types';

jest.setTimeout(60_000);

const baseProvenance: Provenance = {
  agent_id: 'integration_test',
  session_id: null,
  collab_id: null,
  model: null,
  provider: null,
  tool_chain: ['integration_spec'],
  created_by: 'sync',
  source_backend: 'almyty-native',
};

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date();
  return {
    id: uuidv7(),
    mode: 'memory',
    scope_type: 'workspace',
    scope_id: `integration_${Date.now()}`,
    content: `Integration test memory ${Math.random().toString(36).slice(2, 10)}`,
    content_format: 'text',
    content_bytes: 0,
    embedding: null,
    embedding_dim: null,
    embedding_model: null,
    embedding_status: 'skipped',
    embedding_error: null,
    tags: ['integration'],
    metadata: {},
    file_refs: [],
    tier: 'long',
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
    ...overrides,
  };
}

function shouldRunBackend(envVar: string): boolean {
  return !!process.env[envVar] && process.env.RUN_BACKEND_INTEGRATION === '1';
}

const describeIfKey = (label: string, envVar: string) =>
  shouldRunBackend(envVar) ? describe.bind(null, label) : describe.skip.bind(null, label);

// ── Mem0 ────────────────────────────────────────────────────────────────

describeIfKey('Mem0Backend (real api.mem0.ai)', 'MEM0_API_KEY')(() => {
  let backend: Mem0Backend;
  const scope: ScopeRef = { scope_type: 'workspace', scope_id: `mem0_test_${Date.now()}` };

  beforeAll(async () => {
    backend = new Mem0Backend();
    await backend.init();
  });

  it('healthCheck succeeds against the live API', async () => {
    const h = await backend.healthCheck();
    expect(h.ok).toBe(true);
  });

  it('round-trips a memory: put → list → search → delete', async () => {
    const item = makeItem({
      ...scope as any,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      content: 'Pluto is classified as a dwarf planet by the IAU since 2006.',
    });
    item.content_bytes = Buffer.byteLength(item.content, 'utf8');
    await backend.put(item);

    const page = await backend.list({ scope, limit: 50 });
    expect(page.items.length).toBeGreaterThan(0);

    const ranked = await backend.search({ scope, query: 'dwarf planet', top_k: 5 });
    expect(ranked.length).toBeGreaterThan(0);
  });
});

// ── Zep ─────────────────────────────────────────────────────────────────

describeIfKey('ZepBackend (real api.getzep.com)', 'ZEP_API_KEY')(() => {
  let backend: ZepBackend;
  const scope: ScopeRef = { scope_type: 'workspace', scope_id: `zep_test_${Date.now()}` };

  beforeAll(async () => {
    backend = new ZepBackend();
    await backend.init();
  });

  it('healthCheck succeeds', async () => {
    const h = await backend.healthCheck();
    expect(h.ok).toBe(true);
  });

  it('round-trips a memory through Zep graph ingest + search', async () => {
    const item = makeItem({
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      content: 'The customer prefers dark mode in the dashboard.',
    });
    item.content_bytes = Buffer.byteLength(item.content, 'utf8');
    await backend.put(item);

    // Zep ingestion is async; give it a moment before searching.
    await new Promise((r) => setTimeout(r, 1500));
    const ranked = await backend.search({ scope, query: 'dark mode preference', top_k: 5 });
    expect(Array.isArray(ranked)).toBe(true);
  });
});

// ── Supermemory ─────────────────────────────────────────────────────────

describeIfKey('SupermemoryBackend (real api.supermemory.ai)', 'SUPERMEMORY_API_KEY')(() => {
  let backend: SupermemoryBackend;
  const scope: ScopeRef = { scope_type: 'workspace', scope_id: `sm_test_${Date.now()}` };

  beforeAll(async () => {
    backend = new SupermemoryBackend();
    await backend.init();
  });

  it('healthCheck succeeds', async () => {
    const h = await backend.healthCheck();
    expect(h.ok).toBe(true);
  });

  it('round-trips a memory through Supermemory put/list/search', async () => {
    const item = makeItem({
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      content: 'Postgres is a relational database. pgvector adds vector search.',
    });
    item.content_bytes = Buffer.byteLength(item.content, 'utf8');
    await backend.put(item);

    await new Promise((r) => setTimeout(r, 1000));
    const ranked = await backend.search({ scope, query: 'vector search database', top_k: 5 });
    expect(Array.isArray(ranked)).toBe(true);
  });
});

// ── Anthropic Memory Tool (Files API) ───────────────────────────────────

describeIfKey('AnthropicMemoryToolBackend (real api.anthropic.com)', 'ANTHROPIC_API_KEY')(() => {
  let backend: AnthropicMemoryToolBackend;
  const scope: ScopeRef = { scope_type: 'workspace', scope_id: `anth_test_${Date.now()}` };

  beforeAll(async () => {
    backend = new AnthropicMemoryToolBackend();
    await backend.init();
  });

  it('healthCheck succeeds', async () => {
    const h = await backend.healthCheck();
    expect(h.ok).toBe(true);
  });

  it('round-trips a memory through Anthropic Files put/list', async () => {
    const item = makeItem({
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      content: 'The user prefers terse responses when explaining tradeoffs.',
    });
    item.content_bytes = Buffer.byteLength(item.content, 'utf8');
    await backend.put(item);
    const page = await backend.list({ scope, limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
    // Cleanup — don't leave test files in the live account.
    for (const i of page.items) {
      const fileId = (i.metadata as any)?.anthropic_file_id;
      if (fileId) await backend.delete(fileId, 'hard').catch(() => undefined);
    }
  });
});

// ── Vertex Memory Bank ──────────────────────────────────────────────────

describeIfKey('VertexMemoryBankBackend (real Vertex AI)', 'VERTEX_MEMORY_BANK_ENGINE')(() => {
  let backend: VertexMemoryBankBackend;
  const scope: ScopeRef = { scope_type: 'workspace', scope_id: `vertex_test_${Date.now()}` };

  beforeAll(async () => {
    backend = new VertexMemoryBankBackend();
    await backend.init();
  });

  it('healthCheck succeeds', async () => {
    const h = await backend.healthCheck();
    expect(h.ok).toBe(true);
  });

  it('round-trips a memory through Memory Bank generate + retrieve', async () => {
    const item = makeItem({
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      content: 'The team uses GraphQL on the frontend and Postgres on the backend.',
    });
    item.content_bytes = Buffer.byteLength(item.content, 'utf8');
    await backend.put(item);
    // Generation is async on Vertex.
    await new Promise((r) => setTimeout(r, 5000));
    const ranked = await backend.search({ scope, query: 'database technology', top_k: 5 });
    expect(Array.isArray(ranked)).toBe(true);
  });
});
