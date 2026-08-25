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
import { AgentApp } from './agent-app.entity';

/**
 * One attempt at producing a downloadable artifact.
 *
 * Kept as its own row rather than a field on the distribution because
 * builds accumulate: a customer ships v1.2 for three platforms, finds
 * the Windows one unsigned, and rebuilds. Answering "which binary is
 * this person running" later needs the history, not just the latest.
 */
export enum BuildStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  /** Cancelled before the toolchain started. */
  CANCELLED = 'cancelled',
}

@Entity('app_builds')
@Index(['appId', 'createdAt'])
@Index(['organizationId', 'createdAt'])
@Index(['status'])
export class AppBuild {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column({ type: 'uuid' })
  appId: string;

  /** Which distribution this artifact is for: tui, desktop, binary. */
  @Column({ type: 'varchar' })
  target: string;

  /** e.g. macos-arm64. */
  @Column({ type: 'varchar' })
  platform: string;

  @Column({ type: 'varchar', default: BuildStatus.QUEUED })
  status: BuildStatus;

  @Column({ type: 'varchar', nullable: true })
  version: string | null;

  /**
   * Whether the artifact was signed.
   *
   * Recorded rather than inferred from whether credentials existed: a
   * build can have certificates available and still come out unsigned
   * if signing failed, and shipping that difference silently is how
   * someone hands out a binary macOS will refuse to open.
   */
  @Column({ default: false })
  signed: boolean;

  /** Storage key of the artifact. Null until the build succeeds. */
  @Column({ type: 'varchar', nullable: true })
  artifactKey: string | null;

  @Column({ type: 'bigint', nullable: true })
  artifactBytes: string | null;

  /** SHA-256 of the artifact, so a download can be verified. */
  @Column({ type: 'varchar', nullable: true })
  checksum: string | null;

  /**
   * Why it failed, in words the operator can act on. Toolchain output
   * is long and mostly noise, so this holds the diagnosis and the log
   * holds the rest.
   */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'text', nullable: true })
  log: string | null;

  @Column({ type: 'varchar', nullable: true })
  requestedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  /**
   * When the artifact stops being downloadable.
   *
   * Build outputs are large and mostly superseded within days, so they
   * expire by default. The row survives the artifact: knowing a build
   * happened, and what came out, stays useful after the file is gone.
   */
  @Column({ type: 'timestamptz', nullable: true })
  artifactExpiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => AgentApp, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appId' })
  app: AgentApp;

  isDownloadable(now: Date = new Date()): boolean {
    if (this.status !== BuildStatus.SUCCEEDED || !this.artifactKey) return false;
    if (this.artifactExpiresAt && this.artifactExpiresAt.getTime() <= now.getTime()) return false;
    return true;
  }
}
