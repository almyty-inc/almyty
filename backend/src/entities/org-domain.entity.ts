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

export type OrgDomainStatus = 'pending' | 'verified' | 'failed';

/**
 * An email domain an organization has proven it controls, by publishing a
 * DNS TXT record (the same `_almyty-verify` record hosted-chat custom
 * domains use). SSO provisions a new account (JIT, SCIM) only for an
 * address on one of its organization's verified domains, so an org owner
 * cannot mint accounts for addresses at domains they do not run.
 *
 * Any number of organizations may claim a domain while pending, since
 * only its real owner can publish the record; once verified it belongs to
 * one organization (UQ_org_domains_verified_domain).
 */
@Entity('org_domains')
@Index('UQ_org_domains_org_domain', ['organizationId', 'domain'], { unique: true })
export class OrgDomain {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  /** Lowercase hostname, no trailing dot. */
  @Column({ type: 'varchar', length: 253 })
  domain: string;

  /** Published as `almyty-domain-verification=<token>` at `_almyty-verify.<domain>`. */
  @Column({ type: 'varchar', length: 64 })
  verificationToken: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: OrgDomainStatus;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastCheckedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
