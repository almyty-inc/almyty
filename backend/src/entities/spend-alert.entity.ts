import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn,
} from 'typeorm';

import { SpendBudgetPeriod } from './spend-budget.entity';

export type SpendAlertLevel = 'soft' | 'hard';

/**
 * Append-only spend-breach log, mirroring `memory_softcap_warnings`.
 * A row is written the first time a budget crosses its soft (80%) or
 * hard (100%) threshold within a given period. The unique index on
 * (budgetId, periodStart, level) makes the alert fire at most once per
 * period per level — the dedup the alert-delivery layer relies on so
 * a busy org isn't emailed on every run.
 */
@Entity('spend_alerts')
@Index('spend_alerts_org_idx', ['organizationId'])
@Index('spend_alerts_dedup', ['budgetId', 'periodStart', 'level'], { unique: true })
export class SpendAlert {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  budgetId: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  llmProviderId: string | null;

  /** 'soft' = crossed softThresholdPct, 'hard' = reached limitCents. */
  @Column({ type: 'varchar' })
  level: SpendAlertLevel;

  @Column({ type: 'varchar' })
  periodType: SpendBudgetPeriod;

  /** Start of the period bucket this breach belongs to (dedup key). */
  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart: Date;

  /** Period-to-date spend at breach time, in cents. */
  @Column({ type: 'integer' })
  spentCents: number;

  /** The budget's limit at breach time, in cents. */
  @Column({ type: 'integer' })
  limitCents: number;

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at: Date;
}
