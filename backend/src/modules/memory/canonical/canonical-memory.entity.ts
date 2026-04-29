import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import * as pgvector from 'pgvector';
import { Mode, Tier, ScopeType, ContentFormat, EmbeddingStatus, Provenance } from './canonical.types';

/**
 * Canonical memory row.
 *
 * Schema definition lives in the migration (raw SQL — uses pgvector
 * `vector` type, generated `tsvector`, CHECK constraints). This entity
 * mirrors the column shape so the TypeORM repository can do basic CRUD
 * (find / save / soft-update). Vector operations run via raw SQL
 * through `queryRunner.query` because TypeORM doesn't know about
 * `vector` as a column type.
 *
 * The `embedding` column carries a custom transformer that converts
 * between `number[]` (JS shape) and the pgvector text representation
 * `[1,2,3]` (wire format). TypeORM treats the column as `text` for
 * its own purposes; the migration creates it as `vector(N)` so the
 * `<=>` operator and HNSW index work.
 */
@Entity('memories')
@Index('memories_scope', ['scopeType', 'scopeId'])
@Index('memories_scope_mode', ['scopeType', 'scopeId', 'mode'])
@Index('memories_chunk_of', ['chunkOf'])
export class CanonicalMemory {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'mode', type: 'text' })
  mode: Mode;

  @Column({ name: 'scope_type', type: 'text' })
  scopeType: ScopeType;

  @Column({ name: 'scope_id', type: 'text' })
  scopeId: string;

  @Column({ name: 'content', type: 'text' })
  content: string;

  @Column({ name: 'content_format', type: 'text', default: 'text' })
  contentFormat: ContentFormat;

  @Column({ name: 'content_bytes', type: 'integer' })
  contentBytes: number;

  /**
   * pgvector column. TypeORM doesn't know `vector`, so we declare
   * it as text + transformer. The migration creates the real column
   * as `vector` (no fixed dim — pgvector accepts dynamic dim when
   * the column is declared `vector` without a length argument).
   */
  @Column({
    name: 'embedding',
    type: 'text',
    nullable: true,
    transformer: {
      to: (val: number[] | null): string | null =>
        val === null || val === undefined ? null : pgvector.toSql(val),
      from: (val: unknown): number[] | null =>
        val === null || val === undefined ? null : pgvector.fromSql(val as string),
    },
  })
  embedding: number[] | null;

  @Column({ name: 'embedding_dim', type: 'integer', nullable: true })
  embeddingDim: number | null;

  @Column({ name: 'embedding_model', type: 'text', nullable: true })
  embeddingModel: string | null;

  @Column({ name: 'embedding_status', type: 'text', default: 'pending' })
  embeddingStatus: EmbeddingStatus;

  @Column({ name: 'embedding_error', type: 'text', nullable: true })
  embeddingError: string | null;

  @Column({ name: 'tags', type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ name: 'metadata', type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  @Column({ name: 'file_refs', type: 'text', array: true, default: '{}' })
  fileRefs: string[];

  // memory-mode-only fields
  @Column({ name: 'tier', type: 'text', nullable: true })
  tier: Tier | null;

  @Column({ name: 'valid_from', type: 'timestamptz', nullable: true })
  validFrom: Date | null;

  @Column({ name: 'valid_until', type: 'timestamptz', nullable: true })
  validUntil: Date | null;

  @Column({ name: 'superseded_by', type: 'uuid', nullable: true })
  supersededBy: string | null;

  @Column({ name: 'ttl_seconds', type: 'integer', nullable: true })
  ttlSeconds: number | null;

  // document-mode-only fields
  @Column({ name: 'source_uri', type: 'text', nullable: true })
  sourceUri: string | null;

  @Column({ name: 'source_version', type: 'integer', nullable: true })
  sourceVersion: number | null;

  @Column({ name: 'source_checksum', type: 'text', nullable: true })
  sourceChecksum: string | null;

  @Column({ name: 'chunk_index', type: 'integer', nullable: true })
  chunkIndex: number | null;

  @Column({ name: 'chunk_total', type: 'integer', nullable: true })
  chunkTotal: number | null;

  @Column({ name: 'chunk_of', type: 'uuid', nullable: true })
  chunkOf: string | null;

  // quality / lifecycle
  @Column({ name: 'confidence', type: 'real', default: 1.0 })
  confidence: number;

  @Column({ name: 'provenance', type: 'jsonb' })
  provenance: Provenance;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'accessed_at', type: 'timestamptz', nullable: true })
  accessedAt: Date | null;

  @Column({ name: 'access_count', type: 'integer', default: 0 })
  accessCount: number;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @Column({ name: 'deleted_by', type: 'text', nullable: true })
  deletedBy: string | null;

  // The generated tsvector column is populated by Postgres from the
  // `content` field. TypeORM doesn't write to it; the entity carries
  // it so reads can include it when needed (FTS queries usually go
  // through raw SQL anyway).
}
