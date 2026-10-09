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
import { Agent } from './agent.entity';

/**
 * Workspace lifecycle. Once a workspace is in a terminal state
 * (released | expired | stranded), it stays there: clients that
 * attempt to use a stranded workspace get a structured error and
 * are expected to release it and create a fresh one. There is no
 * migration of a workspace from one runner to another in v1.0.
 *
 * Transitions:
 *   active -> released     explicit release() call
 *   active -> expired      BullMQ expiry job sees ttlAt < now
 *   active -> stranded     pinned runner went OFFLINE before release (`job` workspaces only)
 *   active <-> suspended   a `persistent` workspace's pod scaled to zero and back
 *   suspended -> released  released by its owner while parked
 *   suspended -> expired   untouched past the retention window
 *
 * `suspended` is not terminal: the pod is gone, the volume is kept, and
 * the next wake starts a new pod on it. A `persistent` workspace never
 * reaches `stranded`.
 */
export enum WorkspaceStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  RELEASED = 'released',
  EXPIRED = 'expired',
  STRANDED = 'stranded',
}

/** The states a workspace never leaves. */
export const TERMINAL_WORKSPACE_STATUSES: readonly WorkspaceStatus[] = [
  WorkspaceStatus.RELEASED,
  WorkspaceStatus.EXPIRED,
  WorkspaceStatus.STRANDED,
];

/**
 * `job`: made for one job (an agent run and its helpers) or by
 * `POST /workspaces`, on any runner; ends with the job or its TTL.
 * `persistent`: a hosted environment's workspace that outlives runs; it
 * lives on a volume and is suspended rather than stranded.
 */
export type WorkspaceKind = 'job' | 'persistent';

/** What the adapter made for a persistent workspace's volume. Adapter-owned. */
export interface WorkspaceVolumeRef {
  name: string;
  sizeGi: number;
  provider: string;
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

  /**
   * The folder's name on the runner, for a workspace an agent run was
   * given automatically (`<agent>-<run>`). Null for one made through
   * `POST /workspaces`.
   */
  @Column({ type: 'text', nullable: true })
  name: string | null;

  /**
   * The agent whose run needed this workspace (RunWorkspaceService). Null
   * for one made through `POST /workspaces`, and once the agent is deleted.
   */
  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @ManyToOne(() => Agent, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'agentId' })
  agent?: Agent | null;

  /**
   * The run that needed it: an autonomous run (agent_runs) or a workflow
   * execution (agent_executions), so no foreign key. The rest of that run
   * reuses the workspace; at most one active workspace per (run, runner).
   */
  @Column({ type: 'uuid', nullable: true })
  runId: string | null;

  @Column({ type: 'varchar', length: 12, default: 'job' })
  kind: WorkspaceKind;

  /** The environment a `persistent` workspace belongs to. */
  @Column({ type: 'uuid', nullable: true })
  environmentId: string | null;

  /** The volume a `persistent` workspace lives on; adapter-owned. */
  @Column({ type: 'jsonb', nullable: true })
  volumeRef: WorkspaceVolumeRef | null;

  /** Last use of a `persistent` workspace; the retention window counts from here. */
  @Column({ type: 'timestamptz', nullable: true })
  lastActiveAt: Date | null;

  /** When the owner was told a suspended workspace is about to be deleted. */
  @Column({ type: 'timestamptz', nullable: true })
  expiryNoticeAt: Date | null;
}