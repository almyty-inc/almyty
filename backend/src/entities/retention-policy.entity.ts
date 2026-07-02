import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Org-scoped data-retention policy (CORE/OSS).
 *
 * One row per organization (unique). Each `*Days` field is the number of
 * days a data class is kept before the retention sweep deletes it; `null`
 * means keep forever — which is also the behavior for orgs without a row,
 * so existing deployments are unaffected until an admin opts in.
 *
 * Data classes map to tables as follows:
 * - agentRunsDays     -> agent_runs (terminal runs only; running/waiting
 *                        runs are never deleted regardless of age)
 * - conversationsDays -> conversations + their messages
 * - requestLogsDays   -> request_logs (scoped via the org's gateways)
 * - usageMetricsDays  -> usage_metrics
 * - auditLogDays      -> audit_logs
 */
@Entity('retention_policies')
@Index(['organizationId'], { unique: true })
export class RetentionPolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  /** Master switch — a disabled policy is kept but never swept. */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'int', nullable: true })
  agentRunsDays: number | null;

  @Column({ type: 'int', nullable: true })
  conversationsDays: number | null;

  @Column({ type: 'int', nullable: true })
  requestLogsDays: number | null;

  @Column({ type: 'int', nullable: true })
  usageMetricsDays: number | null;

  @Column({ type: 'int', nullable: true })
  auditLogDays: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
