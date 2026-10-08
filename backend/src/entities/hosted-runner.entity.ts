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
import { Organization } from './organization.entity';
import { Environment } from './environment.entity';

/**
 * Where a hosted runner is, as the reconcile loop last saw it.
 *
 *   pending       the row exists; nothing in the cluster yet
 *   provisioning  objects created or a pod starting; waiting for the runner to enroll
 *   ready         the pod runs and its runner is online
 *   suspending    scaled to zero, waiting for the pod to go
 *   suspended     no pod; the volume is kept
 *   failed        three reads in a row failed, or the cluster refused it
 *   tearing_down  asked to go away; retried until it has
 *   torn_down     gone (terminal)
 *   orphaned      the cluster lost it past the grace period (terminal)
 */
export type HostedRunnerState =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'suspending'
  | 'suspended'
  | 'failed'
  | 'tearing_down'
  | 'torn_down'
  | 'orphaned';

export const HOSTED_RUNNER_STATES: readonly HostedRunnerState[] = [
  'pending', 'provisioning', 'ready', 'suspending', 'suspended', 'failed', 'tearing_down', 'torn_down', 'orphaned',
];

/** What services ask for. Written by services, read by the reconcile loop. */
export interface HostedRunnerDesired {
  replicas: 0 | 1;
  resourceClass: string;
  /** Asked to go away; `keepVolume` false deletes the workspace volume too. */
  teardownRequested?: boolean;
  keepVolume?: boolean;
  /** When replicas last went to 1, for the wake budget. */
  wakeRequestedAt?: string | null;
}

/**
 * The provisioner's desired and actual state for one pod, the same split
 * as `model_deployments`: services write `desired` and enqueue; only the
 * reconcile processor writes `state`, `actual`, `externalRef`,
 * `lastError` and `lastReconcileAt` (a guard spec holds it to that).
 *
 * One hosted runner per persistent workspace. Its `runners` row is
 * stable across pod restarts: a new pod enrolls again as the same runner.
 */
@Entity('hosted_runners')
@Index(['organizationId', 'state'])
@Index(['environmentId'])
@Index(['state', 'lastReconcileAt'])
export class HostedRunner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization?: Organization;

  @Column({ type: 'uuid' })
  environmentId: string;

  @ManyToOne(() => Environment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'environmentId' })
  environment?: Environment;

  /** The environment version the current pod was started from. */
  @Column({ type: 'int' })
  environmentVersion: number;

  /** The persistent workspace this pod serves (unique: one pod per workspace). */
  @Column({ type: 'uuid' })
  workspaceId: string;

  /** The `runners` row it enrolls as. */
  @Column({ type: 'uuid', nullable: true })
  runnerId: string | null;

  /** Adapter key: `kubernetes` or `stub`. */
  @Column({ type: 'varchar', length: 32 })
  providerType: string;

  @Column({ type: 'jsonb' })
  desired: HostedRunnerDesired;

  /** Opaque to everything but the adapter. Never a secret. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  providerConfig: Record<string, any>;

  /** Adapter-owned names of what it created (namespace, deployment, volume). */
  @Column({ type: 'jsonb', nullable: true })
  externalRef: Record<string, any> | null;

  /** Last read; never secrets. */
  @Column({ type: 'jsonb', nullable: true })
  actual: Record<string, any> | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  state: HostedRunnerState;

  /** Last dispatch, coding session or viewer; drives the idle timeout. */
  @Column({ type: 'timestamptz', nullable: true })
  lastActiveAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastReconcileAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
