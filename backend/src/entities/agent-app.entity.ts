import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Organization } from './organization.entity';
import { AppDistribution } from './agent-app-distribution.entity';

/**
 * A app: an agent product, packaged under someone else's name.
 *
 * This is the unit a customer ships. It gathers one or more agents, the
 * branding they appear under, who is allowed to talk to them, and what
 * the resulting artifact is permitted to touch on the machine it runs
 * on. The distributions hanging off it are the same product rendered
 * for different places: a web app, a Slack workspace, a terminal, a
 * signed desktop binary.
 *
 * Deliberately separate from Agent. An agent is a capability: what it
 * knows, which models it uses, which tools it may call, how its loop
 * behaves. A app is a product decision: what it is called, who may
 * use it, where it ships. One agent can appear in an internal app
 * and a customer-facing one at the same time, under different names,
 * different auth and different limits, without being duplicated.
 */

/** How an end user of a distributed app proves who they are. */
export enum AppAuthMode {
  /** Anyone with the link or the binary. Requires hard cost caps. */
  PUBLIC_LINK = 'public_link',
  /** One-time code to an email address. */
  EMAIL_OTP = 'email_otp',
  /** The customer's own OAuth provider. */
  OAUTH = 'oauth',
  /** The customer's enterprise directory. Commercial edition. */
  SSO = 'sso',
}

@Entity('agent_apps')
@Index(['organizationId', 'name'])
@Index(['organizationId', 'slug'], { unique: true })
export class AgentApp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column()
  name: string;

  /**
   * Addressable identity of the product: the subdomain a web
   * distribution serves on, and the name a built binary carries.
   * Unique per organization rather than globally, because two customers
   * may both reasonably ship something called "support".
   */
  @Column()
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * The agents this app exposes. An array rather than a single
   * reference because a product is usually more than one specialist,
   * and rather than a join table because that is the convention already
   * used for agent.toolIds. The first entry is the default the user
   * lands on.
   */
  @Column({ type: 'uuid', array: true, default: '{}' })
  agentIds: string[];

  /**
   * Presentation, shared by every distribution so a product looks the
   * same in a browser, a terminal and a dock. Per-distribution config
   * carries only what the medium forces (a terminal has no hex colour,
   * a desktop bundle needs an identifier).
   */
  @Column({ type: 'json', nullable: true })
  branding: {
    appName?: string;
    primaryColor?: string;
    logoUrl?: string | null;
    iconUrl?: string | null;
    greeting?: string;
    theme?: 'dark' | 'light' | 'auto';
    suggestedPrompts?: string[];
    /**
     * EU AI Act Art. 50 line. Null means the default wording. Clearing
     * it entirely requires the white-label entitlement and is audited.
     */
    aiDisclosure?: string | null;
    /** Removes the almyty mark. Commercial edition. */
    whiteLabel?: boolean;
  };

  @Column({ type: 'varchar', default: AppAuthMode.PUBLIC_LINK })
  authMode: AppAuthMode;

  /**
   * What a distributed artifact may do on the machine it runs on.
   *
   * Off by default and deliberately awkward to widen. A branded binary
   * with shell access, handed to end users, is a supply-chain vector:
   * whoever controls the app controls what runs on every machine it
   * was installed on. Nothing here is implied by any other setting.
   */
  @Column({ type: 'json', nullable: true })
  capabilities: {
    /** Read files under these paths. Empty means none. */
    filesystemRead?: string[];
    /** Write files under these paths. Empty means none. */
    filesystemWrite?: string[];
    /** Run local commands. Requires an attached runner. */
    shell?: boolean;
    /** Reach hosts other than the almyty API. */
    network?: boolean;
    /**
     * Ask the end user before anything in this list executes, rather
     * than relying on the grant alone.
     */
    requireApprovalFor?: string[];
  };

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => AppDistribution, (distribution) => distribution.app)
  distributions: AppDistribution[];
}
