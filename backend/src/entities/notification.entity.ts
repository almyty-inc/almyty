import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Persistent in-app notification. One row per recipient — a single
 * emitted event fans out to N rows for N target users. Email delivery
 * is decided at emit time (per-user preference + digest guard) and is
 * not persisted here; the row is the in-app record only.
 *
 * `type` is one of the fixed notification event types (see
 * notification-types.ts). `link` is a frontend-relative path the UI
 * navigates to when the notification is clicked.
 */
@Entity('notifications')
@Index(['userId', 'readAt'])
@Index(['userId', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', nullable: true })
  link: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
