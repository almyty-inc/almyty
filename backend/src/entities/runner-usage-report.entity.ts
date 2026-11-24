import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One hour of one organization's hosted runner minutes for one resource
 * class, as reported (docs/design/hosted-runners-and-always-on.md,
 * "Recording to Stripe"). The hourly `runner-usage-report` job in `ee`
 * writes one row per (organization, class, hour) and sends at most one
 * Stripe meter event for it, under `meterIdentifier`
 * (`<org>:<class>:<hour>`), so a retry never bills twice.
 *
 * `minutes` is what the pods ran in the hour; `billableMinutes` is the
 * part beyond the plan's allowance for the month, in whole minutes
 * (overage by the minute). `destination` says where it went: `stripe`, or
 * `recorded` when nothing is sent (an Enterprise contract, an allowance
 * that covers it, no meter configured for the class). `reportedAt` is set
 * once Stripe accepted the event, or at once for `recorded` rows.
 *
 * Core schema (like every EE-feature entity); only `ee` writes it.
 */
@Entity('runner_usage_reports')
@Index(['organizationId', 'resourceClass', 'hourStart'], { unique: true })
@Index(['reportedAt'])
export class RunnerUsageReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 16 })
  resourceClass: string;

  @Column({ type: 'timestamptz' })
  hourStart: Date;

  @Column({ type: 'double precision' })
  minutes: number;

  @Column({ type: 'integer' })
  billableMinutes: number;

  @Column({ type: 'varchar', length: 16 })
  destination: 'stripe' | 'recorded';

  @Column({ type: 'varchar', length: 128 })
  meterIdentifier: string;

  @Column({ type: 'timestamptz', nullable: true })
  reportedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
