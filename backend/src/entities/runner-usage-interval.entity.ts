import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Minutes a hosted runner pod ran, as the provisioner observed them: an
 * interval opens when the pod is seen ready and closes when it is seen
 * gone (scaled to zero, torn down, failed). The idle tail before the
 * timeout counts, because the pod is running (Frane, 2026-10-08). What a
 * pod says about itself is never the source.
 *
 * Phase 2 records; phase 3 reports them to Stripe from `ee` and fills
 * `reportedAt` and `meterIdentifier`. At most one open interval per
 * hosted runner (a partial unique index).
 */
@Entity('runner_usage_intervals')
@Index(['organizationId', 'startedAt'])
@Index(['hostedRunnerId'])
export class RunnerUsageInterval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  hostedRunnerId: string;

  @Column({ type: 'uuid' })
  environmentId: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ type: 'varchar', length: 16 })
  resourceClass: string;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  reportedAt: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  meterIdentifier: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
