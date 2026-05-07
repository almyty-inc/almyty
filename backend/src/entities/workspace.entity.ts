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
import { User } from './user.entity';
import { Organization } from './organization.entity';
import { Runner, RunnerIsolationTier } from './runner.entity';

/**
 * Workspace lifecycle. Once a workspace is in a terminal state
 * (released | expired | stranded), it stays there: clients that
 * attempt to use a stranded workspace get a structured error and
 * are expected to release it and create a fresh one. There is no
 * migration of a workspace from one runner to another in v1.0.
 *
 * Transitions:
 *   active -> released   explicit release() call
 *   active -> expired    BullMQ expiry job sees ttlAt < now
 *   active -> stranded   pinned runner went OFFLINE before release
 */
export enum WorkspaceStatus {
  ACTIVE = 'active',
  RELEASED = 'released',
  EXPIRED = 'expired',
  STRANDED = 'stranded',
}

@Entity('workspaces')
@Index(['runnerId'])
@Index(['ownerUserId'])
@Index(['organizationId'])
@Index(['status'])
@Index(['ttlAt'])
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Runner this workspace is pinned to. All operations against this
   * workspace dispatch to this runner; if it goes offline, the
   * workspace becomes STRANDED and operations fail loudly.
   */
  @Column()
  runnerId: string;

  @ManyToOne(() => Runner, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'runnerId' })
  runner?: Runner;

  @Column()
  ownerUserId: string;

  @Column()
  organizationId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerUserId' })
  owner?: User;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization?: Organization;

  /**
   * Working directory on the runner. The runner enforces this against
   * its allow-list at create time; the backend stores it for routing
   * and audit. In CONTAINER isolation it's interpreted inside the
   * container; in HOST isolation it's a path on the runner's disk.
   */
  @Column()
  cwd: string;

  @Column({ type: 'enum', enum: RunnerIsolationTier })
  isolation: RunnerIsolationTier;

  /**
   * Time-to-live timestamp. The expiry BullMQ job sweeps for active
   * workspaces past this and marks them EXPIRED, then triggers a
   * release on the runner side. NULL means no TTL (use sparingly;
   * stranded resources are cheap insurance against orphaned shells).
   */
  @Column({ type: 'timestamptz', nullable: true })
  ttlAt: Date | null;

  @Column({ type: 'enum', enum: WorkspaceStatus, default: WorkspaceStatus.ACTIVE })
  status: WorkspaceStatus;

  /**
   * Reason for terminal status. For STRANDED, this is the runner id
   * or name that went offline. For EXPIRED, the TTL value at sweep
   * time. For RELEASED, the userId that released or 'auto' for an
   * agent-initiated release.
   */
  @Column({ type: 'json', nullable: true })
  closeReason: { kind: 'released' | 'expired' | 'stranded'; detail: string } | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;
}
