import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

import { Organization } from './organization.entity';
import { LlmProvider } from './llm-provider.entity';

/**
 * Authoritative usage/cost pulled from an LLM provider's OWN usage API
 * (P7). This is the *provider-actual* side of the cost reconciliation —
 * the complement to our internal estimate (Conversation.totalCost /
 * AgentRun.totalCost). One row per (provider, day) bucket.
 *
 * `source` is always `'provider'` here; the column exists so a future
 * `'estimate'` snapshot source could share the table if we ever
 * materialise our own estimate. `costCents` is integer cents to match
 * SpendService's cents-everywhere convention. `raw` keeps the original
 * bucket payload for audit / debugging.
 *
 * The unique index on (organizationId, llmProviderId, periodStart)
 * makes the fetch-and-store path an idempotent upsert: re-pulling the
 * same date range overwrites rather than duplicates.
 */
@Entity('provider_usage_snapshots')
@Index(['organizationId', 'periodStart'])
@Index(['organizationId', 'llmProviderId', 'periodStart'], { unique: true })
export class ProviderUsageSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column({ type: 'uuid' })
  llmProviderId: string;

  /** Denormalised provider type (openai/anthropic/...) for grouping. */
  @Column({ type: 'varchar' })
  providerType: string;

  /** Inclusive start of the daily bucket (UTC midnight). */
  @Column({ type: 'timestamptz' })
  periodStart: Date;

  /** Exclusive end of the bucket (periodStart + 1 day for daily). */
  @Column({ type: 'timestamptz' })
  periodEnd: Date;

  @Column({ type: 'bigint', default: 0 })
  inputTokens: number;

  @Column({ type: 'bigint', default: 0 })
  outputTokens: number;

  @Column({ type: 'bigint', default: 0 })
  totalTokens: number;

  /** Provider-reported cost for the bucket, in integer cents. */
  @Column({ type: 'integer', default: 0 })
  costCents: number;

  @Column({ type: 'varchar', length: 8, default: 'usd' })
  currency: string;

  /** Where the numbers came from. Always 'provider' for P7. */
  @Column({ type: 'varchar', length: 16, default: 'provider' })
  source: string;

  /** Original provider bucket payload, retained for audit. */
  @Column({ type: 'json', nullable: true })
  raw: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => LlmProvider, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'llmProviderId' })
  llmProvider: LlmProvider;
}
