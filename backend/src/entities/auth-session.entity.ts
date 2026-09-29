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

import { User } from './user.entity';

/**
 * One signed-in session: what a login (or an SSO callback) starts and
 * what logout ends.
 *
 * Access and refresh tokens are signed JWTs, so on their own they stay
 * good until they expire whatever the user does. Each carries this row's
 * id (`sid`), and a token whose row is revoked, expired or gone is
 * refused. The row also holds the one refresh token id (`refreshJti`)
 * that may be redeemed next: a refresh swaps it for a new one, and an
 * older one presented again means the token was copied, so the whole
 * session is revoked.
 */
@Entity('auth_sessions')
@Index('IDX_auth_sessions_userId', ['userId'])
export class AuthSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  /** The refresh token id that may be redeemed next. */
  @Column({ type: 'varchar', length: 64 })
  refreshJti: string;

  /** Set on a session minted from an organization's SSO assertion. */
  @Column({ type: 'uuid', nullable: true })
  ssoOrganizationId: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** `logout` or `refresh_reuse`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  revokedReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
