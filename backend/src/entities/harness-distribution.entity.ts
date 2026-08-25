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
import { Harness } from './harness.entity';

/**
 * One place a harness ships to.
 *
 * The same product rendered for a different medium: a web app on a
 * subdomain, a Slack workspace, a terminal command, a signed desktop
 * app, a standalone binary. Branding, auth and capabilities come from
 * the harness; what lives here is only what the medium itself forces.
 */
export enum DistributionTarget {
  /** Browser app on a subdomain. */
  WEB = 'web',
  /** A messaging platform. The channel gateway carries the credentials. */
  CHANNEL = 'channel',
  /** Terminal UI, run as a command or a compiled executable. */
  TUI = 'tui',
  /** Installable windowed app. */
  DESKTOP = 'desktop',
  /** Standalone executable, no runtime required on the target machine. */
  BINARY = 'binary',
}

/**
 * Where a distribution is in its life.
 *
 * `draft` and `live` apply to anything served by us. `built` applies to
 * artifacts, which we generate but do not host: once a binary is
 * handed over we have no further say in where it goes, which is why
 * there is no `deployed`.
 */
export enum DistributionStatus {
  DRAFT = 'draft',
  BUILDING = 'building',
  BUILT = 'built',
  LIVE = 'live',
  FAILED = 'failed',
}

@Entity('harness_distributions')
@Index(['harnessId', 'target'])
@Index(['organizationId', 'createdAt'])
export class HarnessDistribution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column({ type: 'uuid' })
  harnessId: string;

  @Column({ type: 'varchar' })
  target: DistributionTarget;

  @Column({ type: 'varchar', default: DistributionStatus.DRAFT })
  status: DistributionStatus;

  /**
   * For a CHANNEL distribution, the gateway holding the platform
   * credentials. Null for everything else: a terminal or a binary has
   * no inbound endpoint and no platform account behind it.
   */
  @Column({ type: 'uuid', nullable: true })
  gatewayId: string | null;

  /**
   * Medium-specific settings only. Bundle identifier and window size
   * for desktop; prompt string and ANSI accent for a terminal, which
   * cannot render the harness's hex colour; target triple for a binary.
   */
  @Column({ type: 'json', nullable: true })
  configuration: Record<string, any>;

  /**
   * What the last build produced: platform, version, checksum, and
   * whether it was signed.
   *
   * The artifact itself is not stored here and is never built by us.
   * Signing a macOS app or an Authenticode binary needs the customer's
   * own certificates, and those must not leave their machine, so builds
   * run through the CLI on their hardware or their CI. This records
   * what came out, so a support question about a binary in the wild has
   * an answer.
   */
  @Column({ type: 'json', nullable: true })
  lastBuild: {
    version?: string;
    platform?: string;
    checksum?: string;
    signed?: boolean;
    builtAt?: string;
    builtBy?: string;
    error?: string;
  } | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => Harness, (harness) => harness.distributions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'harnessId' })
  harness: Harness;
}
