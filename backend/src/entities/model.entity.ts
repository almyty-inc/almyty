import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VersionedEntity } from 'typeorm-versions';
import { Organization } from './organization.entity';
import { LlmProvider } from './llm-provider.entity';

/**
 * A row in the model catalog: the machine-readable model card the router
 * reads. It describes something that can answer a chat request: a vendor
 * model behind an existing LlmProvider, a hand-registered OpenAI-compatible
 * endpoint, or a version this organization deployed itself.
 *
 * "Supported" is a property of this data, never of a code list: a model
 * is selectable when its card has a working dispatch path (the provider),
 * a pricing source, and a passing validation run. Nothing else confers it.
 */

export type ModelPrivacyTier = 'local' | 'private_cloud' | 'public';
export type ModelStatus = 'active' | 'inactive' | 'error' | 'deploying';
export type ModelPricingSource =
  | 'feed:litellm'
  | 'feed:openrouter'
  | 'native'
  | 'adapter'
  | 'manual'
  | 'unpriced';
export type ModelValidationStatus = 'never' | 'passed' | 'failed';

export interface ModelCapabilities {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  embedding?: boolean;
  structuredOutput?: boolean;
}

/** Dollars per million tokens. */
export interface ModelPricing {
  inPerMTok: number;
  outPerMTok: number;
  currency: string;
}

export interface ModelLatency {
  p50: number;
  p95: number;
  updatedAt: string;
}

@Entity('models')
@VersionedEntity()
@Index(['organizationId', 'status'])
@Index(['organizationId', 'providerId'])
@Index(['organizationId', 'vendorModelId'])
export class Model {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  /** Human name shown in dropdowns. */
  @Column()
  name: string;

  /** The provider that dispatches calls for this card (the working dispatch path). */
  @Column({ type: 'uuid', nullable: true })
  providerId: string | null;

  @ManyToOne(() => LlmProvider, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'providerId' })
  provider: LlmProvider | null;

  /** Denormalised from the provider so the price feed can key on it without a join. */
  @Column({ type: 'varchar', nullable: true })
  providerType: string | null;

  /** The id the provider expects in the request, e.g. `claude-sonnet-5`. */
  @Column({ type: 'varchar' })
  vendorModelId: string;

  /** Filled by a deployment or a manual registration; null for vendor models. */
  @Column({ type: 'json', nullable: true })
  endpointRef: Record<string, any> | null;

  /** Base architecture family, e.g. `qwen3-14b`. */
  @Column({ type: 'varchar', nullable: true })
  base: string | null;

  @Column({ type: 'uuid', nullable: true })
  modelVersionId: string | null;

  @Column({ type: 'json', default: {} })
  capabilities: ModelCapabilities;

  @Column({ type: 'integer', nullable: true })
  contextLength: number | null;

  /** Effective price: the override when set, else the feed. */
  @Column({ type: 'json', nullable: true })
  pricing: ModelPricing | null;

  @Column({ type: 'varchar', default: 'unpriced' })
  pricingSource: ModelPricingSource;

  @Column({ type: 'timestamp', nullable: true })
  pricingFetchedAt: Date | null;

  /** What an operator typed; wins over the feed until cleared. */
  @Column({ type: 'json', nullable: true })
  pricingOverride: ModelPricing | null;

  @Column({ type: 'json', nullable: true })
  measuredLatencyMs: ModelLatency | null;

  @Column({ type: 'varchar', default: 'public' })
  privacyTier: ModelPrivacyTier;

  @Column({ type: 'varchar', nullable: true })
  region: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status: ModelStatus;

  /** Requirement (d): a passing validation run recorded on the card. */
  @Column({ type: 'varchar', default: 'never' })
  validationStatus: ModelValidationStatus;

  @Column({ type: 'timestamp', nullable: true })
  lastValidatedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastValidationError: string | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;

  /** A card is selectable only when every requirement of the support rule holds. */
  isSelectable(): boolean {
    return (
      this.status === 'active' &&
      !!(this.providerId || this.endpointRef) &&
      this.validationStatus === 'passed'
    );
  }

  effectivePricing(): ModelPricing | null {
    return this.pricingOverride ?? this.pricing;
  }
}
