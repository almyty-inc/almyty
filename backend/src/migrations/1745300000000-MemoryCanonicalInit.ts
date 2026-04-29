import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Canonical memory schema v1.
 *
 * Replaces the legacy `memories` table wholesale (greenfield — see
 * canonical-schema spec §13). This migration:
 *
 *   1. Drops the legacy memory table + any version-tracking sidecar.
 *   2. Enables Postgres extensions: `vector` (pgvector), `pg_trgm`,
 *      `uuid-ossp`. The first is the breaking new dep — it must be
 *      installed and superuser-grantable on the target Postgres.
 *      Managed Postgres providers (DigitalOcean, RDS, Cloud SQL,
 *      Supabase) all expose pgvector; if a deploy target doesn't,
 *      this migration fails loudly.
 *   3. Creates the canonical tables: memories, memory_workspace_config,
 *      memory_softcap_warnings.
 *   4. Builds the index set described in the spec, including the
 *      pgvector HNSW index on `embedding` for cosine similarity.
 *
 * Memory audit lives in the existing `audit_logs` table (project
 * convention) — no separate `memory_audit` table is created. New
 * `AuditAction.MEMORY_*` values are added in code, not in DB DDL.
 */
export class MemoryCanonicalInit1745300000000 implements MigrationInterface {
  name = 'MemoryCanonicalInit1745300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Drop legacy memory tables ────────────────────────────
    await queryRunner.query(`DROP TABLE IF EXISTS memories_versions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS memories CASCADE`);

    // ── 2. Extensions ───────────────────────────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // ── 3. memories table ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE memories (
        id UUID PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('memory','document')),

        scope_type TEXT NOT NULL CHECK (scope_type IN ('user','workspace','project','collab')),
        scope_id TEXT NOT NULL,

        content TEXT NOT NULL,
        content_format TEXT NOT NULL DEFAULT 'text' CHECK (content_format IN ('text','markdown','json')),
        content_bytes INTEGER NOT NULL,

        -- Fixed at 1536 to match the canonical default
        -- (EMBEDDING_DEFAULT_DIM, OpenAI text-embedding-3-small).
        -- pgvector HNSW + IVFFlat indexes require a known dim on
        -- the column; per-workspace dim variation would need
        -- partitioned tables. The memory_workspace_config row
        -- still records the model + dim so the embedding worker
        -- normalises (truncates or zero-pads) to 1536 when a
        -- workspace selects a different-dim model.
        embedding vector(1536),
        embedding_dim INTEGER,
        embedding_model TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (embedding_status IN ('pending','ready','failed','skipped')),
        embedding_error TEXT,

        tags TEXT[] NOT NULL DEFAULT '{}',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        file_refs TEXT[] NOT NULL DEFAULT '{}',

        tier TEXT CHECK (tier IN ('short','project','long','shared')),
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        superseded_by UUID,
        ttl_seconds INTEGER,

        source_uri TEXT,
        source_version INTEGER,
        source_checksum TEXT,
        chunk_index INTEGER,
        chunk_total INTEGER,
        chunk_of UUID,

        confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
        provenance JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        accessed_at TIMESTAMPTZ,
        access_count INTEGER NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        deleted_by TEXT,

        content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

        CONSTRAINT memories_mode_consistent CHECK (
          (mode = 'memory' AND tier IS NOT NULL AND valid_from IS NOT NULL
            AND source_uri IS NULL AND chunk_index IS NULL AND chunk_of IS NULL)
          OR
          (mode = 'document' AND source_uri IS NOT NULL AND source_version IS NOT NULL
            AND tier IS NULL AND valid_until IS NULL AND superseded_by IS NULL AND ttl_seconds IS NULL)
        ),
        CONSTRAINT memories_temporal_order CHECK (
          valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from
        ),
        CONSTRAINT memories_supersede_requires_until CHECK (
          superseded_by IS NULL OR valid_until IS NOT NULL
        ),
        CONSTRAINT memories_chunk_consistent CHECK (
          chunk_index IS NULL OR (chunk_total IS NOT NULL AND chunk_index < chunk_total)
        )
      )
    `);

    // FK constraints added separately so the table can self-reference.
    await queryRunner.query(`
      ALTER TABLE memories
        ADD CONSTRAINT memories_superseded_by_fk
        FOREIGN KEY (superseded_by) REFERENCES memories(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE memories
        ADD CONSTRAINT memories_chunk_of_fk
        FOREIGN KEY (chunk_of) REFERENCES memories(id) ON DELETE CASCADE
    `);

    // ── 4. Indexes on memories ─────────────────────────────────
    await queryRunner.query(`CREATE INDEX memories_scope ON memories (scope_type, scope_id)`);
    await queryRunner.query(`CREATE INDEX memories_scope_mode ON memories (scope_type, scope_id, mode)`);
    await queryRunner.query(`
      CREATE INDEX memories_scope_tier ON memories (scope_type, scope_id, tier)
        WHERE mode = 'memory'
    `);
    await queryRunner.query(`
      CREATE INDEX memories_current ON memories (scope_type, scope_id, mode, tier)
        WHERE valid_until IS NULL AND deleted_at IS NULL
    `);
    await queryRunner.query(`CREATE INDEX memories_tags ON memories USING GIN (tags)`);
    await queryRunner.query(`CREATE INDEX memories_metadata ON memories USING GIN (metadata jsonb_path_ops)`);
    await queryRunner.query(`CREATE INDEX memories_tsv ON memories USING GIN (content_tsv)`);
    await queryRunner.query(`
      CREATE INDEX memories_embedding ON memories USING hnsw (embedding vector_cosine_ops)
        WHERE embedding IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX memories_ttl ON memories (created_at)
        WHERE ttl_seconds IS NOT NULL AND valid_until IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX memories_source ON memories (source_uri, source_version)
        WHERE mode = 'document'
    `);
    await queryRunner.query(`
      CREATE INDEX memories_chunk_of ON memories (chunk_of)
        WHERE chunk_of IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX memories_pending_emb ON memories (created_at)
        WHERE embedding_status = 'pending'
    `);

    // ── 5. memory_workspace_config ─────────────────────────────
    await queryRunner.query(`
      CREATE TABLE memory_workspace_config (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_dim INTEGER NOT NULL,
        embedding_provider TEXT NOT NULL,
        softcap_behavior TEXT NOT NULL DEFAULT 'warn_log'
          CHECK (softcap_behavior IN ('reject','warn_log','silent')),
        overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_type, scope_id)
      )
    `);

    // ── 6. memory_softcap_warnings ─────────────────────────────
    await queryRunner.query(`
      CREATE TABLE memory_softcap_warnings (
        id BIGSERIAL PRIMARY KEY,
        memory_id UUID NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        tier TEXT,
        mode TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        soft_cap INTEGER NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX memory_softcap_scope
        ON memory_softcap_warnings (scope_type, scope_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS memory_softcap_warnings CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS memory_workspace_config CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS memories CASCADE`);
    // Don't drop extensions on `down`; they may be used by other features.
  }
}
