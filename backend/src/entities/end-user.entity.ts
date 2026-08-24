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
import { Gateway } from './gateway.entity';

/**
 * A person talking to an agent from outside the organization.
 *
 * Deliberately NOT the same thing as a `User`. A User is someone who
 * logs into almyty and builds things. An end user is a member of the
 * public who opened a hosted chat link or a widget, and who may never
 * authenticate at all.
 *
 * Anonymity is a property of the row, not a separate code path: an
 * anonymous visitor still gets an end_user row, keyed by a cookie, and
 * `externalId`/`authProvider` stay null. That is why "public by link" is
 * a flag on the surface rather than a different architecture, and why
 * adding email OTP or SSO later fills in two columns instead of
 * introducing a second identity model.
 */
@Entity('end_users')
@Index(['gatewayId', 'sessionKey'], { unique: true })
@Index(['organizationId', 'createdAt'])
@Index(['gatewayId', 'externalId'])
export class EndUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  /** The surface this person arrived through. */
  @Column()
  gatewayId: string;

  /**
   * Opaque per-surface session identifier, held in an httpOnly cookie
   * scoped to that surface's host. This is what makes an anonymous
   * visitor durable across page loads without any login. Unique per
   * gateway so the same browser talking to two tenants is two people.
   */
  @Column()
  sessionKey: string;

  /**
   * The identifier the authenticating system knows this person by, once
   * they authenticate. Null for anonymous visitors.
   */
  @Column({ type: 'varchar', nullable: true })
  externalId: string | null;

  /** 'email_otp' | 'oauth' | 'sso', or null while anonymous. */
  @Column({ type: 'varchar', nullable: true })
  authProvider: string | null;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true })
  displayName: string | null;

  /**
   * Coarse client fingerprint for per-IP rate limiting on public links.
   * Stored hashed rather than raw: it is only ever compared, never
   * displayed, and a public chat surface should not accumulate a
   * plaintext IP log of everyone who used it.
   */
  @Column({ type: 'varchar', nullable: true })
  clientHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => Gateway, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  isAnonymous(): boolean {
    return !this.authProvider;
  }
}
