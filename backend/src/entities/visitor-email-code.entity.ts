import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * A one-time sign-in code sent to a hosted-chat visitor's email address.
 *
 * Only a keyed hash of the code is kept (`codeHash`). The row belongs to
 * the visitor session that asked for it; see VisitorEmailOtpService for
 * the single-use, expiry and attempt rules, and migration
 * 1750811000000-VisitorEmailCodes for the table.
 */
@Entity('visitor_email_codes')
@Index(['gatewayId', 'endUserId', 'createdAt'])
@Index(['expiresAt'])
export class VisitorEmailCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column()
  gatewayId: string;

  /** The visitor (browser session) the code was issued to. */
  @Column()
  endUserId: string;

  /** Lowercased address the code was sent to. */
  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  clientHash: string | null;

  /** HMAC-SHA256 of the code, bound to this row and address. */
  @Column({ type: 'varchar', length: 64 })
  codeHash: string;

  /** Wrong guesses so far; the code dies at the limit. */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** Set once, when the code is redeemed or superseded. */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
