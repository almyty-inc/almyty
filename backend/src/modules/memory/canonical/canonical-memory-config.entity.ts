import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { ScopeType } from './canonical.types';
import { SoftCapBehavior } from './canonical.constants';

/**
 * Per-workspace memory configuration. The (scope_type, scope_id)
 * tuple is the natural key — there's at most one config row per
 * memory scope.
 *
 * Embedding model + dim are stored here so the dim is consistent
 * across all rows in a given scope. Cross-workspace dim variation
 * is supported because the `memories.embedding` column is declared
 * `vector` (no fixed dim).
 *
 * `softcap_behavior` can override the system default per scope:
 * `'reject'` blocks oversize writes, `'warn_log'` lets them through
 * with an audit warning, `'silent'` lets them through quietly.
 */
@Entity('memory_workspace_config')
export class CanonicalMemoryWorkspaceConfig {
  @PrimaryColumn({ name: 'scope_type', type: 'text' })
  scopeType: ScopeType;

  @PrimaryColumn({ name: 'scope_id', type: 'text' })
  scopeId: string;

  @Column({ name: 'embedding_model', type: 'text' })
  embeddingModel: string;

  @Column({ name: 'embedding_dim', type: 'integer' })
  embeddingDim: number;

  @Column({ name: 'embedding_provider', type: 'text' })
  embeddingProvider: string;

  @Column({ name: 'softcap_behavior', type: 'text', default: 'warn_log' })
  softcapBehavior: SoftCapBehavior;

  /** Per-scope overrides for hard caps + soft caps + anti-dump knobs. */
  @Column({ name: 'overrides', type: 'jsonb', default: () => "'{}'::jsonb" })
  overrides: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
