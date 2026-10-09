import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VersionedEntity } from 'typeorm-versions';
import { Organization } from './organization.entity';
import { User } from './user.entity';

/** Where the environment's code comes from. The git credential is a connection, never a column. */
export interface EnvironmentRepo {
  url: string;
  ref?: string | null;
  connectionId?: string | null;
}

/**
 * The curated image a pod runs. `base` is a name from the settings'
 * `images`; `ref` is the reference (ideally digest-pinned) it resolved to
 * when this version was saved, so a version keeps running the bytes it
 * was made with. Custom images are not offered (Frane, 2026-10-08).
 */
export interface EnvironmentImage {
  base: string;
  ref: string;
}

/**
 * An environment variable the pod gets from a connection: the field
 * `field` of connection `connectionId`, as `envVar`. A reference only;
 * the value is resolved at pod start, audited, and lives in the pod's
 * Secret, never in this row.
 */
export interface EnvironmentEnvBinding {
  connectionId: string;
  field: string;
  envVar: string;
}

export interface EnvironmentCache {
  paths: string[];
}

/** Hosts the pod may reach over TLS, enforced at the network by SNI. */
export interface EnvironmentEgress {
  allowHosts: string[];
  /** Binaries the runner may run; a guard rail inside the sandbox, not the boundary. */
  allowBinaries?: string[];
}

/**
 * A machine an organization describes once and reuses: repository,
 * curated image, setup script, connection-backed variables, cache paths,
 * egress allowlist and size. almyty starts a pod for it when an agent
 * needs one and parks it when idle (docs/hosted-runners.md).
 *
 * Visibility follows every other resource (private, team, org), with one
 * difference: team and org visibility are the `hosted_shared_environments`
 * entitlement (Business). The gate is on the write only; reading and
 * listing go through the access policy like any other row.
 */
@Entity('environments')
@VersionedEntity()
@Index(['organizationId'])
export class Environment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization?: Organization;

  @Column({ type: 'uuid' })
  ownerUserId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerUserId' })
  owner?: User;

  @Column({ type: 'varchar', length: 8, default: 'private' })
  visibility: 'private' | 'team' | 'org';

  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  /** Unique per organization among live environments. */
  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'jsonb', nullable: true })
  repo: EnvironmentRepo | null;

  @Column({ type: 'jsonb' })
  image: EnvironmentImage;

  /** Runs once per workspace volume per environment version. */
  @Column({ type: 'text', nullable: true })
  setupScript: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  envBindings: EnvironmentEnvBinding[];

  @Column({ type: 'jsonb', default: () => `'{"paths":[]}'::jsonb` })
  cache: EnvironmentCache;

  @Column({ type: 'jsonb', default: () => `'{"allowHosts":[]}'::jsonb` })
  egress: EnvironmentEgress;

  /** A key of the settings' `resourceClasses`; the billable unit. */
  @Column({ type: 'varchar', length: 16 })
  resourceClass: string;

  /** Minutes idle before scale to zero, within the settings' bounds. */
  @Column({ type: 'int' })
  idleTimeoutMinutes: number;

  /**
   * The organization's own cluster (an org-owned `kubernetes`
   * connection). Null means the platform pool. Enterprise, phase 4: the
   * service refuses a value until then.
   */
  @Column({ type: 'uuid', nullable: true })
  clusterConnectionId: string | null;

  /**
   * Whether this environment may put a model provider's own key into its
   * pods (an `envBindings` entry naming a model provider's connection), for
   * a CLI that cannot change its base URL. Off unless turned on: CLIs
   * reach models through almyty with the pod-scoped token (Decision 6).
   */
  @Column({ type: 'boolean', default: false })
  allowVendorKeys: boolean;

  /** Bumped on every saved change; a hosted runner records the version its pod started from. */
  @Column({ type: 'int', default: 1 })
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  /** Soft delete: the reconcile loop tears down what is left. */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
