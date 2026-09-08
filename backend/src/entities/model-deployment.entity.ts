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
import { ModelVersion } from './model-version.entity';
import { decryptField, encryptField, isEncrypted } from '../common/security/field-crypto';

/**
 * A version running somewhere: desired state written by controllers,
 * actual state written only by the reconcile loop.
 *
 * Invariant: nothing vendor-specific lives outside `providerConfig`
 * (what the adapter needs, validated by the adapter's schema) and
 * `externalRef` (what the adapter created). Secrets inside providerConfig
 * are encrypted in place; they never appear in `actual`, audit events or
 * logs.
 */

export type ModelDeploymentState =
  | 'pending'
  | 'deploying'
  | 'ready'
  | 'degraded'
  | 'scaling'
  | 'tearing_down'
  | 'orphaned'
  | 'torn_down'
  | 'failed';


export interface ModelDeploymentDesired {
  hardware?: string;
  replicas?: number;
  minScale?: number;
  maxScale?: number;
  quantization?: string;
  region?: string;
  privacyTier?: 'local' | 'private_cloud' | 'public';
}

/** providerConfig keys treated as secrets, whatever the adapter calls them. */
const SECRET_KEY = /(token|secret|password|apikey|api_key|credential|accesskey|access_key|serviceaccount|privatekey|private_key)/i;

@Entity('model_deployments')
@VersionedEntity()
@Index(['organizationId', 'state'])
@Index(['organizationId', 'modelVersionId'])
@Index(['providerType', 'state'])
export class ModelDeployment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @Column({ type: 'uuid' })
  modelVersionId: string;

  @ManyToOne(() => ModelVersion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'modelVersionId' })
  modelVersion: ModelVersion;

  /** The catalog card this deployment fills once it is ready. */
  @Column({ type: 'uuid', nullable: true })
  modelId: string | null;

  /** Adapter key, e.g. `modal`, `huggingface-endpoints`. */
  @Column({ type: 'varchar' })
  providerType: string;

  @Column({ type: 'json', default: {} })
  desired: ModelDeploymentDesired;

  /** Opaque to everything but the adapter; secret keys encrypted in place. */
  @Column({ type: 'json', default: {} })
  providerConfig: Record<string, any>;

  /** What the adapter created; adapter-owned. */
  @Column({ type: 'json', nullable: true })
  externalRef: Record<string, any> | null;

  /** Last reconcile read. Never contains secrets. */
  @Column({ type: 'json', nullable: true })
  actual: Record<string, any> | null;

  @Column({ type: 'varchar', default: 'pending' })
  state: ModelDeploymentState;

  @Column({ type: 'timestamp', nullable: true })
  lastReconcileAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'uuid', nullable: true })
  budgetId: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;

  /** Encrypt secret-looking providerConfig values in place. Idempotent. */
  encryptSensitiveData(): void {
    for (const [key, value] of Object.entries(this.providerConfig ?? {})) {
      if (SECRET_KEY.test(key) && typeof value === 'string' && value && !isEncrypted(value)) {
        this.providerConfig[key] = encryptField(value);
      }
    }
  }

  /** The same, through the organization's envelope (BYO-KMS) when one is configured. */
  async encryptSensitiveDataForOrg(envelope: {
    encryptForOrg(orgId: string, plaintext: string): Promise<string>;
  }): Promise<void> {
    for (const [key, value] of Object.entries(this.providerConfig ?? {})) {
      if (SECRET_KEY.test(key) && typeof value === 'string' && value && !isEncrypted(value)) {
        this.providerConfig[key] = await envelope.encryptForOrg(this.organizationId, value);
      }
    }
  }

  /** A copy of providerConfig with secrets decrypted, for the adapter only. */
  getDecryptedProviderConfig(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(this.providerConfig ?? {})) {
      out[key] = SECRET_KEY.test(key) && typeof value === 'string' ? decryptField(value, this.organizationId) : value;
    }
    return out;
  }

  /** What the API returns: secrets replaced, never revealed. */
  toPublicView(): Record<string, any> {
    const masked: Record<string, any> = {};
    for (const [key, value] of Object.entries(this.providerConfig ?? {})) {
      masked[key] = SECRET_KEY.test(key) && value ? '********' : value;
    }
    return { ...this, providerConfig: masked, organization: undefined, modelVersion: undefined };
  }

  static isSecretKey(key: string): boolean {
    return SECRET_KEY.test(key);
  }
}
