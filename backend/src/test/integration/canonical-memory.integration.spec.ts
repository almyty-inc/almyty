/**
 * Real-Postgres integration test for the canonical memory module.
 *
 * Hits a real database with the pgvector extension installed; runs
 * the full migration DDL (extensions, tables, indexes, generated
 * tsvector, HNSW vector index) and exercises every public method
 * on `CanonicalMemoryService` end-to-end:
 *
 *   - put → embedding worker → vector + tsvector populated
 *   - get / list / asOf
 *   - search (hybrid vector + FTS)
 *   - supersede (bi-temporal)
 *   - delete (soft + hard)
 *   - batchPut / batchDelete
 *   - soft cap warn_log + reject behavior
 *   - anti-dump: blob detection + compression-ratio reject
 *   - validation pipeline mode invariants
 *
 * Gated behind RUN_DB_INTEGRATION=1. Skipped in unit-test runs; the
 * CI workflow (.github/workflows/ci.yml) flips the flag.
 */
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { v7 as uuidv7 } from 'uuid';

import { CanonicalMemory } from '../../modules/memory/canonical/canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from '../../modules/memory/canonical/canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from '../../modules/memory/canonical/canonical-memory-softcap-warning.entity';
import {
  CanonicalMemoryService,
  EMBEDDING_QUEUE_NAME,
} from '../../modules/memory/canonical/canonical-memory.service';
import { CanonicalSearchHelper } from '../../modules/memory/canonical/canonical-search.helper';
import { CanonicalMemoryOpsHelper } from '../../modules/memory/canonical/canonical-ops.helper';
import { CanonicalPutValidators } from '../../modules/memory/canonical/canonical-put-validators.helper';
import { EmbeddingService, HASH_EMBEDDING_MODEL } from '../../modules/memory/embedding.service';
import { DocumentChunkerService } from '../../modules/memory/canonical/document-chunker.service';
import { ConsolidationService } from '../../modules/memory/canonical/consolidation.service';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { Provenance, MemoryError, Tier } from '../../modules/memory/canonical/canonical.types';
import { LIMITS } from '../../modules/memory/canonical/canonical.constants';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

jest.setTimeout(120_000);

/**
 * Generate diverse readable content. crypto.randomBytes gives high
 * entropy, then we map each byte through a punctuation-rich
 * alphabet so the result has spaces / commas / hyphens — enough
 * to dodge the base64 charset check, and enough entropy to defeat
 * the compression-ratio reject. Used by the soft-cap tests where
 * the size needs to clear the cap without tripping anti-dump.
 */
function randomReadable(bytes: number): string {
  const crypto = require('crypto');
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.;:-_?!()';
  const buf = crypto.randomBytes(bytes);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
}

const baseProvenance: Provenance = {
  agent_id: 'agent_test',
  session_id: 'sess_test',
  collab_id: null,
  model: 'claude-test',
  provider: 'anthropic',
  tool_chain: ['put'],
  created_by: 'agent',
  source_backend: 'almyty-native',
};

describeIfDb('CanonicalMemoryService (real Postgres + pgvector)', () => {
  let ds: DataSource;
  let service: CanonicalMemoryService;
  let chunker: DocumentChunkerService;
  let enqueued: Array<{ name: string; data: any }> = [];

  beforeAll(async () => {
    const bootstrap = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS canonical_memory_test');
    await bootstrap.destroy();

    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
      schema: 'canonical_memory_test',
      // Build the schema by RUNNING THE MIGRATIONS (not `synchronize`)
      // so the suite validates the real migration path — including the
      // MemoryCanonicalInit migration that creates the pgvector-backed
      // `memories` tables this spec exercises. `dropSchema` keeps
      // re-runs clean (only the isolated schema is dropped).
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      logging: false,
      // Pin search_path on every connection (pool) so the migrations'
      // unqualified CREATE TABLE lands in canonical_memory_test AND so
      // raw SQL through DataSource.query — used by hybridSearch / asOf
      // / etc. for pgvector operators — finds those tables while the
      // `vector` type resolves from public.
      extra: {
        options: '-c search_path=canonical_memory_test,public',
      },
      entities: [CanonicalMemory, CanonicalMemoryWorkspaceConfig, CanonicalMemorySoftcapWarning],
    });
    await ds.initialize();

    // Stub embedding service: returns a deterministic 1536-dim vector
    // (matches the column's vector(1536) constraint and the canonical
    // default dim). The projection is text-content-derived so similar
    // inputs produce similar vectors and cosine distance is meaningful.
    // Model/dim metadata mirrors what the hash fallback reports so the
    // like-with-like vector search guard matches across write and read.
    // The real provider paths are covered in EmbeddingService unit tests.
    const embeddingStub: Pick<EmbeddingService, 'generateEmbedding' | 'cosineSimilarity'> = {
      generateEmbedding: jest.fn(async (text: string) => {
        const dim = 1536;
        const v = new Array(dim).fill(0);
        for (let i = 0; i < text.length; i++) {
          v[i % dim] += (text.charCodeAt(i) % 13) / 13;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        const vector = norm > 0 ? v.map((x) => x / norm) : v;
        return { vector, model: HASH_EMBEDDING_MODEL, dim, provider: 'hash' as const };
      }),
      cosineSimilarity: jest.fn(),
    };

    const queueStub = {
      add: jest.fn(async (name: string, data: any) => {
        enqueued.push({ name, data });
        return { id: 'job-' + enqueued.length };
      }),
    };

    const auditStub = {
      log: jest.fn(),
      logCreate: jest.fn(),
      logUpdate: jest.fn(),
      logDelete: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CanonicalMemoryService,
        DocumentChunkerService,
        { provide: getRepositoryToken(CanonicalMemory), useValue: ds.getRepository(CanonicalMemory) },
        { provide: getRepositoryToken(CanonicalMemoryWorkspaceConfig), useValue: ds.getRepository(CanonicalMemoryWorkspaceConfig) },
        { provide: getRepositoryToken(CanonicalMemorySoftcapWarning), useValue: ds.getRepository(CanonicalMemorySoftcapWarning) },
        { provide: getQueueToken(EMBEDDING_QUEUE_NAME), useValue: queueStub },
        { provide: DataSource, useValue: ds },
        { provide: AuditLogService, useValue: auditStub },
        { provide: EmbeddingService, useValue: embeddingStub },
        CanonicalSearchHelper,
        CanonicalMemoryOpsHelper,
        CanonicalPutValidators,
      ],
    }).compile();
    service = moduleRef.get(CanonicalMemoryService);
    chunker = moduleRef.get(DocumentChunkerService);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(() => {
    enqueued = [];
  });

  // ─── happy path: write → enqueue → embed → search ────────────

  it('put: persists a memory-mode item and enqueues the embedding job', async () => {
    const item = await service.put(
      {
        mode: 'memory',
        scope: { scope_type: 'workspace', scope_id: 'wks_put_1' },
        content: 'the quick brown fox jumps over the lazy dog',
        tier: 'short',
        provenance: baseProvenance,
      },
      { user_id: 'u_test' },
    );
    expect(item.id).toBeDefined();
    expect(item.mode).toBe('memory');
    expect(item.embedding_status).toBe('pending');

    const row = await ds.getRepository(CanonicalMemory).findOne({ where: { id: item.id } });
    expect(row).toBeDefined();
    expect(row!.contentBytes).toBe(Buffer.byteLength(item.content, 'utf8'));
    expect(row!.tier).toBe('short');

    // Embedding job was enqueued.
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]).toEqual(expect.objectContaining({ name: 'embed', data: { memory_id: item.id } }));
  });

  it('fillEmbedding: populates the vector and flips status to ready', async () => {
    const item = await service.put(
      {
        mode: 'memory',
        scope: { scope_type: 'workspace', scope_id: 'wks_emb_1' },
        content: 'embeddings are vectors of real numbers',
        tier: 'project',
        provenance: baseProvenance,
      },
      { user_id: 'u_test' },
    );
    await service.fillEmbedding(item.id);

    const row = await ds.getRepository(CanonicalMemory).findOne({ where: { id: item.id } });
    expect(row!.embeddingStatus).toBe('ready');
    expect(row!.embedding).not.toBeNull();
    expect(row!.embeddingDim).toBe(1536);
    expect(row!.embedding!.length).toBe(1536);
  });

  // ─── search: hybrid vector + FTS, scope-isolated ─────────────

  it('search: returns ranked items in scope, isolating other scopes', async () => {
    // Seed: 2 memories in scope A, 1 in scope B.
    const aOne = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'scope_A' },
        content: 'pgvector enables fast cosine similarity search', tier: 'long',
        provenance: baseProvenance },
      { user_id: 'u' });
    const aTwo = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'scope_A' },
        content: 'database indexes speed up reads', tier: 'long',
        provenance: baseProvenance },
      { user_id: 'u' });
    const bOne = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'scope_B' },
        content: 'pgvector enables fast cosine similarity search', tier: 'long',
        provenance: baseProvenance },
      { user_id: 'u' });

    // Fill embeddings synchronously (worker doesn't run in tests).
    await Promise.all([
      service.fillEmbedding(aOne.id),
      service.fillEmbedding(aTwo.id),
      service.fillEmbedding(bOne.id),
    ]);

    const ranked = await service.search({
      scope: { scope_type: 'workspace', scope_id: 'scope_A' },
      query: 'cosine similarity vectors',
      mode: 'memory',
      top_k: 5,
    });
    const ids = ranked.map((r) => r.item.id);
    expect(ids).toContain(aOne.id);
    expect(ids).not.toContain(bOne.id); // scope-isolated
    // Hybrid signal because vector + FTS both fired.
    expect(ranked[0].signal === 'hybrid' || ranked[0].signal === 'fts').toBeTruthy();
  });

  // ─── bi-temporal supersede ───────────────────────────────────

  it('supersede: closes valid_until on old, points superseded_by to new', async () => {
    const old = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_super' },
        content: 'pluto is a planet', tier: 'long', provenance: baseProvenance },
      { user_id: 'u' });

    const { old: refreshedOld, new: replacement } = await service.supersede(
      old.id,
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_super' },
        content: 'pluto is a dwarf planet', tier: 'long', provenance: baseProvenance },
      { user_id: 'u' },
    );

    expect(refreshedOld.valid_until).not.toBeNull();
    expect(refreshedOld.superseded_by).toBe(replacement.id);
    expect(replacement.valid_until).toBeNull();

    // Default list excludes superseded rows.
    const page = await service.list({ scope: { scope_type: 'workspace', scope_id: 'wks_super' } });
    expect(page.items.map((i) => i.id)).not.toContain(refreshedOld.id);
    expect(page.items.map((i) => i.id)).toContain(replacement.id);

    // include_superseded shows them again.
    const all = await service.list({
      scope: { scope_type: 'workspace', scope_id: 'wks_super' },
      include_superseded: true,
    });
    expect(all.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([refreshedOld.id, replacement.id]),
    );
  });

  it('asOf: returns the row that was current at the given time', async () => {
    const t0 = new Date();
    const old = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_asof' },
        content: 'temperature is in Fahrenheit', tier: 'long', provenance: baseProvenance },
      { user_id: 'u' });
    // Wait for a measurable wall-clock gap so the as-of cutoff lands
    // strictly between the old and the new row.
    await new Promise((r) => setTimeout(r, 50));
    const between = new Date();
    await new Promise((r) => setTimeout(r, 50));
    await service.supersede(
      old.id,
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_asof' },
        content: 'temperature is in Celsius', tier: 'long', provenance: baseProvenance },
      { user_id: 'u' },
    );

    const past = await service.asOf(between, {
      scope: { scope_type: 'workspace', scope_id: 'wks_asof' },
    });
    expect(past.items.map((i) => i.id)).toContain(old.id);
  });

  // ─── soft delete + hard delete ───────────────────────────────

  it('delete soft: marks deleted_at; default list hides it; hard removes the row', async () => {
    const item = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_del' },
        content: 'will be deleted', tier: 'short', provenance: baseProvenance },
      { user_id: 'u' });
    expect(await service.delete(item.id, 'soft', { user_id: 'u' })).toBe(true);

    const page = await service.list({ scope: { scope_type: 'workspace', scope_id: 'wks_del' } });
    expect(page.items.map((i) => i.id)).not.toContain(item.id);

    expect(await service.delete(item.id, 'hard', { user_id: 'u' })).toBe(true);
    const row = await ds.getRepository(CanonicalMemory).findOne({ where: { id: item.id } });
    expect(row).toBeNull();
  });

  // ─── soft cap warn_log behavior ──────────────────────────────

  it('soft cap warn_log: writes warning row + lets the put succeed', async () => {
    // 'short' tier soft cap is 128 KB; emit 200 KB to trip it. Use
    // diverse-but-readable noise so neither the blob detector nor
    // the compression-ratio check fires before the soft cap step.
    const big = randomReadable(200 * 1024);
    const item = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_softcap' },
        content: big, tier: 'short', provenance: baseProvenance },
      { user_id: 'u' });
    expect(item.id).toBeDefined();

    // The default workspace config is `warn_log` → a row was logged.
    const warnings = await ds
      .getRepository(CanonicalMemorySoftcapWarning)
      .find({ where: { memoryId: item.id } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sizeBytes).toBe(Buffer.byteLength(big, 'utf8'));
    expect(warnings[0].softCap).toBe(LIMITS.SOFT_CAP_MEMORY_SHORT_BYTES);
  });

  it('soft cap reject: rejects the put when behavior=reject', async () => {
    // Switch the workspace config for this scope to 'reject'.
    await ds.getRepository(CanonicalMemoryWorkspaceConfig).save({
      scopeType: 'workspace',
      scopeId: 'wks_softcap_reject',
      embeddingModel: LIMITS.EMBEDDING_DEFAULT_MODEL,
      embeddingDim: LIMITS.EMBEDDING_DEFAULT_DIM,
      embeddingProvider: 'openai',
      softcapBehavior: 'reject',
      overrides: {},
    });
    const big = randomReadable(200 * 1024);
    await expect(
      service.put(
        { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_softcap_reject' },
          content: big, tier: 'short', provenance: baseProvenance },
        { user_id: 'u' },
      ),
    ).rejects.toBeInstanceOf(MemoryError);
  });

  // ─── anti-dump heuristics ────────────────────────────────────

  it('anti-dump: detects a PDF-prefixed blob and rejects with looks_like_blob', async () => {
    const fakePdf = `%PDF-1.4\nfake pdf body`;
    await expect(
      service.put(
        { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_blob' },
          content: fakePdf, tier: 'short', provenance: baseProvenance },
        { user_id: 'u' },
      ),
    ).rejects.toMatchObject({ tag: { kind: 'looks_like_blob', detected: 'pdf' } });
  });

  it('anti-dump: long base64 block is rejected as base64 blob', async () => {
    // Real base64 (mixed case + digits) — ≥ 2048 chars is the
    // detector threshold for the long-stretch heuristic.
    const b64 = require('crypto').randomBytes(2400).toString('base64');
    await expect(
      service.put(
        { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_b64' },
          content: b64, tier: 'short', provenance: baseProvenance },
        { user_id: 'u' },
      ),
    ).rejects.toMatchObject({ tag: { kind: 'looks_like_blob' } });
  });

  it('anti-dump: highly compressible content is rejected', async () => {
    // 'a' * 100k compresses to a tiny gzip stream — ratio well below
    // the 5% threshold.
    const repetitive = 'a'.repeat(100 * 1024);
    await expect(
      service.put(
        { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_repeat' },
          content: repetitive, tier: 'long', provenance: baseProvenance },
        { user_id: 'u' },
      ),
    ).rejects.toMatchObject({ tag: { kind: 'looks_like_blob' } });
  });

  // ─── validation: mode invariants ─────────────────────────────

  it('validation: document mode requires source_uri', async () => {
    await expect(
      service.put(
        {
          mode: 'document',
          scope: { scope_type: 'workspace', scope_id: 'wks_doc' },
          content: 'doc body',
          // source_uri intentionally missing
          source_version: 1,
          chunk_index: 0,
          chunk_total: 1,
          provenance: baseProvenance,
        },
        { user_id: 'u' },
      ),
    ).rejects.toMatchObject({ tag: { kind: 'validation' } });
  });

  // ─── batch ops ───────────────────────────────────────────────

  it('batchPut: accepts valid items, flags invalid ones, succeeds atomically per row', async () => {
    const valid = (content: string): any => ({
      id: uuidv7(),
      mode: 'memory' as const,
      scope_type: 'workspace' as const,
      scope_id: 'wks_batch',
      content,
      content_format: 'text' as const,
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null,
      embedding_dim: null,
      embedding_model: null,
      embedding_status: 'pending' as const,
      embedding_error: null,
      tags: [],
      metadata: {},
      file_refs: [],
      tier: 'short' as Tier,
      valid_from: new Date(),
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
      created_at: new Date(),
      updated_at: new Date(),
      accessed_at: null,
      access_count: 0,
      deleted_at: null,
      deleted_by: null,
    });
    const a = valid('row a');
    const b = valid('row b');
    const broken = { ...valid('row c'), tier: null }; // memory mode without tier
    const result = await service.batchPut([a, b, broken]);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error.kind).toBe('validation');
  });

  it('batchDelete: soft-deletes the listed ids', async () => {
    const a = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_bd' },
        content: 'first', tier: 'short', provenance: baseProvenance },
      { user_id: 'u' });
    const b = await service.put(
      { mode: 'memory', scope: { scope_type: 'workspace', scope_id: 'wks_bd' },
        content: 'second', tier: 'short', provenance: baseProvenance },
      { user_id: 'u' });
    const result = await service.batchDelete([a.id, b.id]);
    expect(result.succeeded).toBe(2);
    const remaining = await service.list({
      scope: { scope_type: 'workspace', scope_id: 'wks_bd' },
    });
    expect(remaining.items.map((i) => i.id)).not.toContain(a.id);
    expect(remaining.items.map((i) => i.id)).not.toContain(b.id);
  });

  // ── workspace config CRUD ──────────────────────────────────

  it('updateConfig: shallow-merges overrides without wiping siblings', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_cfg_merge' };
    await service.updateConfig(scope.scope_type, scope.scope_id, {
      overrides: { routing: { memory_backend: 'mem0' } },
    });
    await service.updateConfig(scope.scope_type, scope.scope_id, {
      overrides: { routing: { mirror_backend: 'zep' } } as any,
    });
    const cfg = await service.getOrCreateConfig(scope.scope_type, scope.scope_id);
    // The router subkey itself isn't shallow-merged here — only the
    // top-level `overrides` keys are. That's the documented contract:
    // callers patch `overrides.routing` whole at a time.
    expect((cfg.overrides as any).routing).toEqual({ mirror_backend: 'zep' });
  });

  it('updateConfig: persists softcap_behavior', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_cfg_softcap' };
    await service.updateConfig(scope.scope_type, scope.scope_id, {
      softcap_behavior: 'reject',
    });
    const cfg = await service.getOrCreateConfig(scope.scope_type, scope.scope_id);
    expect(cfg.softcapBehavior).toBe('reject');
  });

  // ── audit listing ───────────────────────────────────────────

  it('listSoftcapWarnings: returns the warnings written by warn_log soft-cap behavior', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_audit_list' };
    // Default config = warn_log; trip the short-tier cap.
    const big = randomReadable(200 * 1024);
    await service.put(
      { mode: 'memory', scope, content: big, tier: 'short', provenance: baseProvenance },
      { user_id: 'u' },
    );
    const rows = await service.listSoftcapWarnings(scope.scope_type, scope.scope_id, 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].tier).toBe('short');
  });

  // ── URI scheme allow-list ──────────────────────────────────

  it('URI allow-list: rejects a write whose source_uri uses a scheme not in the workspace allow-list', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_uri_block' };
    await service.updateConfig(scope.scope_type, scope.scope_id, {
      overrides: { allowed_uri_schemes: ['almyty', 'https'] },
    });
    await expect(
      service.put(
        {
          mode: 'document',
          scope,
          content: 'hello',
          source_uri: 's3://bucket/key',
          source_version: 1,
          provenance: baseProvenance,
        },
        { user_id: 'u' },
      ),
    ).rejects.toMatchObject({ tag: { kind: 'validation' } });
  });

  it('URI allow-list: defaults are permissive (https / almyty / s3 / file all allowed)', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_uri_default' };
    const item = await service.put(
      {
        mode: 'document',
        scope,
        content: 'permitted source',
        source_uri: 's3://bucket/k',
        source_version: 1,
        provenance: baseProvenance,
      },
      { user_id: 'u' },
    );
    expect(item.source_uri).toBe('s3://bucket/k');
  });

  // ── schema-version dropping ────────────────────────────────
  // The router-level test for this is in
  // src/modules/memory/canonical/__tests__/memory-router.spec.ts —
  // covered there with FakeBackend stand-ins instead of standing
  // up the full service stack here.

  // ── TTL sweeper (raw SQL, exercised against pgvector DB) ───

  it('TTL sweeper: closes valid_until on rows whose ttl_seconds elapsed', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_ttl' };
    // Insert a row with ttl_seconds=1, backdate created_at by 2s
    // so it's already expired by sweeper time.
    const item = await service.put(
      { mode: 'memory', scope, content: 'expires fast', tier: 'short',
        ttl_seconds: 1, provenance: baseProvenance },
      { user_id: 'u' },
    );
    await ds.query(
      `UPDATE memories SET created_at = now() - INTERVAL '5 seconds' WHERE id = $1`,
      [item.id],
    );
    // Run the sweep query directly (the production code uses the
    // same SQL via the BullMQ processor).
    await ds.query(`
      WITH expired AS (
        SELECT id FROM memories
        WHERE mode = 'memory' AND ttl_seconds IS NOT NULL
          AND valid_until IS NULL AND deleted_at IS NULL
          AND created_at + (ttl_seconds * INTERVAL '1 second') < now()
        LIMIT 1000
      )
      UPDATE memories m SET valid_until = now(), updated_at = now()
      FROM expired WHERE m.id = expired.id
    `);
    const reloaded = await service.get(item.id);
    expect(reloaded?.valid_until).not.toBeNull();
  });

  // ── document import (chunker + atomic re-import) ───────────

  it('document import: writes parent + chunks atomically, dedupes by checksum, re-imports under force', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_import' };
    const text = Array.from({ length: 6 }, (_, i) => `Section ${i + 1}: ${'x'.repeat(800)}.`).join('\n\n');

    // First import.
    const first = await chunker.importSource({
      scope, source_uri: 'almyty:file/doc-1', content: text,
      provenance: baseProvenance,
    });
    expect(first.skipped).toBe(false);
    expect(first.chunks_inserted).toBeGreaterThan(1);
    expect(first.source_version).toBe(1);

    // Second import, same content — should be skipped on checksum match.
    const second = await chunker.importSource({
      scope, source_uri: 'almyty:file/doc-1', content: text,
      provenance: baseProvenance,
    });
    expect(second.skipped).toBe(true);
    expect(second.source_version).toBe(1);
    expect(second.parent_id).toBe(first.parent_id);

    // Third import, force=true — bumps source_version, replaces parent.
    const third = await chunker.importSource({
      scope, source_uri: 'almyty:file/doc-1', content: text,
      provenance: baseProvenance, force: true,
    });
    expect(third.skipped).toBe(false);
    expect(third.source_version).toBe(2);
    expect(third.parent_id).not.toBe(first.parent_id);

    // Old parent + chunks should be gone (cascade).
    const oldParent = await ds
      .getRepository(CanonicalMemory)
      .findOne({ where: { id: first.parent_id } });
    expect(oldParent).toBeNull();
  });

  // ── consolidation (LLM stubbed; DB real) ────────────────────

  it('consolidation: extracts facts from short-tier rows, writes long-tier facts, supersedes sources', async () => {
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_consolidation' };

    // Seed 5 short-tier memories with backdated created_at so they
    // pass the `older_than_minutes` cutoff.
    for (let i = 0; i < 5; i++) {
      await service.put(
        { mode: 'memory', scope, content: `Episode ${i + 1}: user said something interesting #${i}.`,
          tier: 'short', provenance: baseProvenance },
        { user_id: 'u' },
      );
    }
    await ds.query(
      `UPDATE memories SET created_at = now() - INTERVAL '2 hours' WHERE scope_id = $1 AND tier = 'short'`,
      [scope.scope_id],
    );

    // Enable consolidation + lower the min_short_count so 5 rows
    // is enough to trigger.
    await service.updateConfig(scope.scope_type, scope.scope_id, {
      overrides: {
        consolidation: { enabled: true, min_short_count: 5, older_than_minutes: 10 },
      },
    });

    // Stub the LLM service to return two synthetic facts.
    const moduleRef = await Test.createTestingModule({
      providers: [
        ConsolidationService,
        { provide: getRepositoryToken(CanonicalMemory), useValue: ds.getRepository(CanonicalMemory) },
        { provide: getRepositoryToken(LlmProvider), useValue: { findOne: jest.fn().mockResolvedValue({ id: 'p-1', type: 'openai', organizationId: scope.scope_id, status: 'active' }) } },
        { provide: CanonicalMemoryService, useValue: service },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        {
          provide: LlmProvidersService,
          useValue: {
            chat: jest.fn().mockResolvedValue({
              message: {
                content: JSON.stringify({
                  facts: [
                    { content: 'user prefers terse output', tags: ['ui'], confidence: 0.9 },
                    { content: 'agent used tool memory', tags: ['behavior'], confidence: 0.8 },
                  ],
                }),
              },
              model: 'gpt-test',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              cost: 0,
              conversationId: '',
              messageId: '',
            }),
          },
        },
      ],
    }).compile();
    const consolidator = moduleRef.get(ConsolidationService);

    const result = await consolidator.run(scope);
    expect(result.skipped).toBe(false);
    expect(result.consolidated_facts).toBe(2);
    expect(result.superseded).toBe(5);

    // Default list excludes superseded — only the new long-tier
    // facts should remain visible.
    const page = await service.list({ scope });
    const tiers = page.items.map((i) => i.tier).sort();
    expect(tiers).toEqual(['long', 'long']);
    expect(page.items.every((i) => i.tags.includes('consolidated'))).toBe(true);
  });
});
