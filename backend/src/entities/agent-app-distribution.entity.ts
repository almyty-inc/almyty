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
 * One place a app ships to.
 *
 * The same product rendered for a different medium: a web app on a
 * subdomain, a Slack workspace, a terminal command, a signed desktop
 * app, a standalone binary. Branding, auth and capabilities come from
 * the app; what lives here is only what the medium itself forces.
 */
export enum DistributionTarget {
  /** Browser app on its own address. */
  WEB = 'web',
  /** Terminal UI, run as a command or a compiled executable. */
  TUI = 'tui',
  /** Installable windowed app. */
  DESKTOP = 'desktop',
  /** Standalone executable, no runtime required on the target machine. */
  BINARY = 'binary',
  // Messaging platforms are listed individually rather than collapsed
  // into one "channel" target. An app ships to Slack, not to an
  // abstraction, and naming the platform is what makes a distribution
  // uniquely addressable as /apps/acme/distributions/slack instead of
  // needing an opaque id to tell two channel rows apart.
  SLACK = 'slack',
  DISCORD = 'discord',
  TELEGRAM = 'telegram',
  WHATSAPP = 'whatsapp',
  WHATSAPP_CLOUD = 'whatsapp_cloud',
  SMS = 'sms',
  MICROSOFT_TEAMS = 'microsoft_teams',
  GOOGLE_CHAT = 'google_chat',
  EMAIL = 'email',
  SIGNAL = 'signal',
  MATRIX = 'matrix',
  IRC = 'irc',
  WEBHOOK = 'webhook',
}

/** Targets backed by a messaging gateway holding platform credentials. */
export const CHANNEL_TARGETS: readonly DistributionTarget[] = Object.freeze([
  DistributionTarget.SLACK,
  DistributionTarget.DISCORD,
  DistributionTarget.TELEGRAM,
  DistributionTarget.WHATSAPP,
  DistributionTarget.WHATSAPP_CLOUD,
  DistributionTarget.SMS,
  DistributionTarget.MICROSOFT_TEAMS,
  DistributionTarget.GOOGLE_CHAT,
  DistributionTarget.EMAIL,
  DistributionTarget.SIGNAL,
  DistributionTarget.MATRIX,
  DistributionTarget.IRC,
  DistributionTarget.WEBHOOK,
]);

export function isChannelTarget(target: DistributionTarget | string): boolean {
  return (CHANNEL_TARGETS as readonly string[]).includes(target as string);
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

@Entity('agent_app_distributions')
@Index(['appId', 'target'], { unique: true })
@Index(['organizationId', 'createdAt'])
export class AppDistribution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column({ type: 'uuid' })
  appId: string;

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
   * cannot render the app's hex colour; target triple for a binary.
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

  @ManyToOne(() => AgentApp, (app) => app.distributions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appId' })
  app: AgentApp;
}
