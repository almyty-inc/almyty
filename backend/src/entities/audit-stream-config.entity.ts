import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type AuditStreamTarget = 'webhook' | 'splunk_hec' | 'datadog';

/**
 * EE (audit_export): per-org configuration for streaming audit events to
 * an external SIEM. The basic audit-log (write + in-app query) stays OSS;
 * a licensed deployment can additionally forward each event to a
 * generic webhook, a Splunk HTTP Event Collector, or the Datadog Logs
 * intake API.
 *
 * The `token` is the target's shared secret (HEC token, DD API key, or a
 * bearer for a plain webhook). It is stored as-is here for brevity; a
 * production hardening follow-up should route it through the same
 * envelope encryption used for llm-provider keys.
 */
@Entity('audit_stream_configs')
@Index(['organizationId', 'enabled'])
export class AuditStreamConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 32 })
  target: AuditStreamTarget;

  /** Fully-qualified ingest URL for the target. */
  @Column({ type: 'text' })
  endpoint: string;

  /** HEC token / DD API key / webhook bearer. */
  @Column({ type: 'text', nullable: true })
  token: string | null;

  /**
   * Optional allow-list of audit actions to forward. Empty/null =
   * forward everything.
   */
  @Column({ type: 'jsonb', nullable: true })
  actionFilter: string[] | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Last successful delivery, for lightweight health surfacing. */
  @Column({ type: 'timestamptz', nullable: true })
  lastDeliveredAt: Date | null;

  /** Last delivery error message, if any. */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
