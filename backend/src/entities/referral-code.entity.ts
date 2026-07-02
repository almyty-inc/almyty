import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Organization } from './organization.entity';

/**
 * A user's personal referral code. One row per user (create-or-get).
 *
 * `accruedRewardDays` banks earned reward days for referrers whose org is
 * still on the free plan — the program only APPLIES plan-time to orgs on
 * pro, so free-tier referrers accrue and the qualification sweep applies
 * the bank once the org upgrades.
 */
@Entity('referral_codes')
@Index(['userId'], { unique: true })
@Index(['code'], { unique: true })
export class ReferralCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 32 })
  code: string;

  @Column({ default: true })
  active: boolean;

  /** Reward days earned while the referrer's org was on free — applied on upgrade to pro. */
  @Column({ type: 'int', default: 0 })
  accruedRewardDays: number;

  /** IP the code was created from — compared against referee registration IPs (abuse guardrail). */
  @Column({ type: 'varchar', nullable: true })
  createdFromIp: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
