import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { User } from './user.entity';
import { Organization } from './organization.entity';

/**
 * Runner state machine. Single source of truth in this enum; every
 * transition lives in RunnerService. The state is what routing checks
 * before dispatching: `online` and `busy` accept work, anything else
 * surfaces a structured error to the caller.
 *
 * Transitions:
 *   registered            initial; runner has registered but never sent a heartbeat
 *   registered -> online  first heartbeat received
 *   online <-> busy       workspace count > 0 -> busy; back to 0 -> online
 *   online|busy -> stale  3 missed heartbeats (~90s with the 30s heartbeat interval)
 *   stale -> online|busy  heartbeat resumes within the 5 min grace window
 *   stale -> offline      grace expires
 *   any -> draining       clean shutdown signal received
 *   draining -> offline   in-flight jobs complete or grace expires
 */
export enum RunnerState {
  REGISTERED = 'registered',
  ONLINE = 'online',
  BUSY = 'busy',
  DRAINING = 'draining',
  STALE = 'stale',
  OFFLINE = 'offline',
}

/**
 * Isolation tier, intentionally limited to two values in v1.0:
 *
 *   container  podman or docker, the default for new workspaces
 *   host       no isolation; the runner runs jobs in its own filesystem.
 *              Required for development workstations and the demo path.
 *
 * WASM and firejail are explicit anti-goals for v1.0; do not add them.
 */
export enum RunnerIsolationTier {
  CONTAINER = 'container',
  HOST = 'host',
}

/**
 * Runtime info detected by the runner at startup. Every field is
 * read-only from the user's perspective; the runner reports it on
 * registration and refreshes on heartbeats. Detected fields are in
 * a parallel namespace to `labels`: a user-set label `os: macos` is
 * a routing tag, while `runtimeInfo.os: 'darwin'` is what the runner
 * reports. Both can coexist; routing rules can match either.
 */
export interface RunnerRuntimeInfo {
  os: string;             // 'darwin' | 'linux' | 'win32'
  arch: string;           // 'x64' | 'arm64' | etc.
  hostname: string;
  cpuCount: number;
  memoryMb: number;
  runnerVersion: string;
  /**
   * Detected binaries. Keys are binary names from the probe list
   * (node, python, git, claude, codex, gemini, aider, ...). Values
   * are version strings ("v20.18.0", "git version 2.47.0", "1.2.3"),
   * or null when the binary is not on PATH or `--version` failed.
   */
  binaries: Record<string, string | null>;
}

/**
 * Runner-side configuration, set by the user and pushed to the
 * backend on registration. The backend may further constrain (a
 * lower max_concurrent than what the runner sent, for instance) but
 * never escalate.
 */
export interface RunnerConfig {
  defaultIsolation: RunnerIsolationTier;
  maxConcurrent: number;
  /** Allow-list of cwd prefixes the runner will create workspaces in. */
  allowedCwdRoots: string[];
  /** Deny patterns matched against any cwd or shell.exec command. */
  denyPatterns: string[];
  /** When true, the runner refuses outbound network calls inside isolation. */
  networkBlocked: boolean;
  /** When true, install commands (npm install, pip install, etc.) are blocked. */
  installBlocked: boolean;
}

@Entity('runners')
@Index(['ownerUserId'])
@Index(['organizationId'])
@Index(['state'])
@Index(['ownerUserId', 'organizationId'], { unique: true })
export class Runner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * User-chosen name. Unique per (owner_user_id, organization_id).
   * Routing tools refer to runners by name + owner, not by id, so
   * users can rebuild a machine and re-register with the same name
   * without breaking saved tool references.
   */
  @Column()
  name: string;

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

  @Column({ type: 'enum', enum: RunnerState, default: RunnerState.REGISTERED })
  state: RunnerState;

  /**
   * User-chosen labels for routing. Distinct from the detected fields
   * in `runtimeInfo` so a user can set `env: production` without
   * colliding with anything the runner detects automatically.
   */
  @Column({ type: 'json', default: () => `'{}'::json` })
  labels: Record<string, string>;

  @Column({ type: 'json', nullable: true })
  runtimeInfo: RunnerRuntimeInfo | null;

  @Column({ type: 'json', nullable: true })
  config: RunnerConfig | null;

  /**
   * Last time we received a heartbeat envelope. Drives the
   * online -> stale transition (3 missed = ~90s with default
   * 30s interval).
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastHeartbeatAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  registeredAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany('RunnerSession', 'runner')
  sessions?: any[];
}
