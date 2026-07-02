import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ReferralStatus {
  /** Attributed at signup; referred org has not activated yet. */
  PENDING = 'pending',
  /** Referred org activated (created a gateway AND ran an agent) — tier-1 granted. */
  QUALIFIED = 'qualified',
  /** Referred org converted to a paid plan — tier-2 granted, terminal state. */
  REWARDED = 'rewarded',
}

export enum ReferralAbuseFlag {
  SAME_IP = 'same_ip',
  DISPOSABLE_EMAIL = 'disposable_email',
}

/**
 * One referred signup. Flagged referrals (abuseFlag set) never auto-reward —
 * they surface as "pending review" in the referrer's stats until a human
 * clears them.
 */
@Entity('referrals')
@Index(['referrerUserId'])
@Index(['referredUserId'], { unique: true })
@Index(['status'])
export class Referral {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  referrerUserId: string;

  @Column({ type: 'uuid' })
  referredUserId: string;

  @Column({ type: 'uuid' })
  referredOrganizationId: string;

  @Column({ type: 'uuid', nullable: true })
  referralCodeId: string | null;

  @Column({ type: 'varchar', default: ReferralStatus.PENDING })
  status: ReferralStatus;

  @Column({ type: 'timestamptz', nullable: true })
  qualifiedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  rewardedAt: Date | null;

  /** Total referrer reward days granted (banked or applied) for this referral. */
  @Column({ type: 'int', default: 0 })
  rewardDays: number;

  @Column({ type: 'varchar', nullable: true })
  abuseFlag: ReferralAbuseFlag | null;

  @Column({ type: 'varchar', nullable: true })
  abuseReason: string | null;

  /** Registration IP of the referred user (abuse guardrail). */
  @Column({ type: 'varchar', nullable: true })
  ipAddress: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
