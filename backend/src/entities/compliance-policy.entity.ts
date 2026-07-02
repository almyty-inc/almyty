import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** Built-in plugins the compliance pack can enforce org-wide. */
export type EnforceablePlugin = 'pii-filter' | 'security-scanner';

/** Severity floor at/above which the security scanner blocks a request. */
export type ComplianceSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * EE (compliance_pack): an org-scoped policy that turns the OSS built-in
 * pii-filter + security-scanner plugins into an ENFORCED, non-optional
 * layer. On a community deployment those plugins are opt-in per gateway;
 * this policy makes them mandatory across the org and records the
 * thresholds a compliance report is scored against.
 *
 * One row per organization (upserted) — a missing row means "no enforced
 * policy", and the service returns a documented default effective policy.
 */
@Entity('compliance_policies')
@Index(['organizationId'], { unique: true })
export class CompliancePolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  /**
   * Which built-in plugins are enforced org-wide. Empty = the policy row
   * exists but enforces nothing (still blocks the feature behind the gate).
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  enforcedPlugins: EnforceablePlugin[];

  /** Security-scanner severity floor that blocks a request. */
  @Column({ type: 'varchar', length: 16, default: 'medium' })
  securityThreshold: ComplianceSeverity;

  /**
   * When true a policy violation aborts the request; when false it is
   * only recorded (audit/report) — "monitor" mode for onboarding.
   */
  @Column({ type: 'boolean', default: true })
  blockOnViolation: boolean;

  /** PII categories the filter must mask. Empty = all built-in categories. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  piiCategories: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
