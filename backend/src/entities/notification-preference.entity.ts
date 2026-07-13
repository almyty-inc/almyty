import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Per-user, per-event-type notification channel preference. Rows exist
 * only for explicit overrides — a user with no row for a type gets the
 * built-in defaults (see notification-types.ts). This keeps the table
 * tiny and lets us evolve the defaults without a backfill.
 */
@Entity('notification_preferences')
@Index(['userId', 'type'], { unique: true })
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'boolean', default: true })
  inApp: boolean;

  @Column({ type: 'boolean', default: true })
  email: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
