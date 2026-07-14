import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';

import { Organization } from './organization.entity';

/**
 * How much of the LLM budget an operator's own keys may burn per
 * period, and what happens on breach. This is the *cross-run* ceiling
 * — the complement to the per-run `AgentRun.limits.maxCostCents` cap.
 *
 * The `behavior` field reuses the memory module's SoftCapBehavior
 * semantics (`canonical.constants.ts`): `'reject'` blocks new runs
 * once period-to-date spend reaches the limit; `'warn_log'` records a
 * SpendAlert (and emails) but lets runs proceed. `softThresholdPct`
 * (default 80) fires an earlier soft alert before the hard limit.
 *
 * Scope: `organizationId` is required. `agentId` / `llmProviderId`
 * narrow the budget to a single agent or provider; both null means an
 * org-wide budget.
 */
export type SpendBudgetPeriod = 'day' | 'month';
export type SpendBudgetBehavior = 'warn_log' | 'reject';

@Entity('spend_budgets')
@Index(['organizationId', 'agentId'])
export class SpendBudget {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  /** Narrow to one agent. Null = applies to all agents in the org. */
  @Column({ nullable: true })
  agentId: string | null;

  /** Narrow to one LLM provider. Null = applies to all providers. */
  @Column({ nullable: true })
  llmProviderId: string | null;

  /** Rolling period the limit resets on. */
  @Column({ type: 'varchar', default: 'month' })
  periodType: SpendBudgetPeriod;

  /** Hard ceiling for the period, in integer cents. */
  @Column({ type: 'integer' })
  limitCents: number;

  /** What to do when period-to-date spend reaches `limitCents`. */
  @Column({ type: 'varchar', default: 'warn_log' })
  behavior: SpendBudgetBehavior;

  /** Soft-warning threshold as a percentage of the limit (1-100). */
  @Column({ type: 'integer', default: 80 })
  softThresholdPct: number;

  /** Inactive budgets are kept for history but never enforced. */
  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
