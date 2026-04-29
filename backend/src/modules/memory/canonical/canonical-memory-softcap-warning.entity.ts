import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';
import { Mode, ScopeType, Tier } from './canonical.types';

/**
 * Soft-cap warning log. Appended whenever a write exceeds a soft
 * cap and the workspace's `softcap_behavior` is `'warn_log'`. The
 * audit dashboard surfaces these per-scope so operators can spot
 * agents that consistently over-write.
 */
@Entity('memory_softcap_warnings')
@Index('memory_softcap_scope', ['scopeType', 'scopeId'])
export class CanonicalMemorySoftcapWarning {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'memory_id', type: 'uuid' })
  memoryId: string;

  @Column({ name: 'scope_type', type: 'text' })
  scopeType: ScopeType;

  @Column({ name: 'scope_id', type: 'text' })
  scopeId: string;

  @Column({ name: 'tier', type: 'text', nullable: true })
  tier: Tier | null;

  @Column({ name: 'mode', type: 'text' })
  mode: Mode;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes: number;

  @Column({ name: 'soft_cap', type: 'integer' })
  softCap: number;

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at: Date;
}
