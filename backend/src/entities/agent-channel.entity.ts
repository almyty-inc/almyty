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
import { Agent } from './agent.entity';

/**
 * One way people (or other agents) reach an agent: a channel.
 *
 * An agent has many channels and a channel has exactly one agent. The web
 * chat link, the website widget, each messaging platform, the A2A endpoint
 * for other agents, and the desktop and terminal apps people download are
 * all channels, added and edited on the agent's Channels tab and nowhere
 * else.
 *
 * Branding and visitor rules live on the agent (Agent.branding,
 * Agent.visitorRules). A channel carries only what its medium forces
 * (platform keys, a bundle id, an address) plus, optionally, its own
 * branding and visitor rules that override the agent's field by field.
 */
export enum ChannelType {
  /** Web chat: a chat page on its own link. */
  WEB = 'web',
  /** Website widget: a chat bubble on someone's own site, added with a script tag. */
  WIDGET = 'widget',
  /** Other agents call this one over A2A. */
  A2A = 'a2a',
  /** Terminal app, compiled to a download. */
  TUI = 'tui',
  /** Desktop app, packaged and signed. */
  DESKTOP = 'desktop',
  SLACK = 'slack',
  DISCORD = 'discord',
  TELEGRAM = 'telegram',
  WHATSAPP = 'whatsapp',
  WHATSAPP_CLOUD = 'whatsapp_cloud',
  SMS = 'sms',
  /** iMessage through the Sendblue relay. */
  IMESSAGE_SENDBLUE = 'imessage_sendblue',
  /** iMessage through the LoopMessage relay. */
  IMESSAGE_LOOPMESSAGE = 'imessage_loopmessage',
  MICROSOFT_TEAMS = 'microsoft_teams',
  GOOGLE_CHAT = 'google_chat',
  EMAIL = 'email',
  SIGNAL = 'signal',
  MATRIX = 'matrix',
  IRC = 'irc',
  WEBHOOK = 'webhook',
}

/** Channels backed by a messaging platform, each needing that platform's keys. */
export const MESSAGING_CHANNEL_TYPES: readonly ChannelType[] = Object.freeze([
  ChannelType.SLACK,
  ChannelType.DISCORD,
  ChannelType.TELEGRAM,
  ChannelType.WHATSAPP,
  ChannelType.WHATSAPP_CLOUD,
  ChannelType.SMS,
  ChannelType.IMESSAGE_SENDBLUE,
  ChannelType.IMESSAGE_LOOPMESSAGE,
  ChannelType.MICROSOFT_TEAMS,
  ChannelType.GOOGLE_CHAT,
  ChannelType.EMAIL,
  ChannelType.SIGNAL,
  ChannelType.MATRIX,
  ChannelType.IRC,
  ChannelType.WEBHOOK,
]);

export function isMessagingChannel(type: ChannelType | string): boolean {
  return (MESSAGING_CHANNEL_TYPES as readonly string[]).includes(type as string);
}

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && (Object.values(ChannelType) as string[]).includes(value);
}

/**
 * Where a channel is in its life. `draft` and `live` apply to anything
 * served by us; `building`, `built` and `failed` to the downloads.
 */
export enum ChannelStatus {
  DRAFT = 'draft',
  BUILDING = 'building',
  BUILT = 'built',
  LIVE = 'live',
  FAILED = 'failed',
}

/** How a visitor proves who they are before they can talk to the agent. */
export enum VisitorAuthMode {
  /** Anyone with the link or the download. */
  PUBLIC_LINK = 'public_link',
  /** One-time code to an email address. */
  EMAIL_OTP = 'email_otp',
  /** The customer's own OAuth provider. */
  OAUTH = 'oauth',
  /** The customer's enterprise directory. Commercial edition. */
  SSO = 'sso',
}

/** Name, colours, logo and greeting people see. */
export interface ChannelBranding {
  appName?: string;
  primaryColor?: string;
  logoUrl?: string | null;
  iconUrl?: string | null;
  greeting?: string;
  theme?: 'dark' | 'light' | 'auto';
  suggestedPrompts?: string[];
  /**
   * EU AI Act Art. 50 line. Null means the default wording. Clearing it
   * entirely requires the white-label entitlement.
   */
  aiDisclosure?: string | null;
  /** Removes the almyty mark. Commercial edition. */
  whiteLabel?: boolean;
}

/**
 * What a stranger is allowed to cost. Null means none; a missing field
 * means the default (see channel-rules.ts).
 */
export interface VisitorLimits {
  /** Ceiling on what one run may cost, in cents. */
  costCapCents?: number | null;
  /** Messages per hour per visitor. */
  perUserRateLimit?: number | null;
  /** Messages per hour per IP address. */
  perIpRateLimit?: number | null;
  /** Spend per UTC day, in cents, across every visitor. */
  dailySpendCapCents?: number | null;
  /** Spend per UTC month, in cents. */
  monthlySpendCapCents?: number | null;
}

/** What visitors may do with their own data, and how long it is kept. */
export interface VisitorPrivacy {
  /** Days to keep visitor conversations. Null means the organization policy; it can only shorten it. */
  retentionDays?: number | null;
  /** Visitors may delete their own conversations, or everything about them. */
  visitorCanDelete?: boolean;
  /** Visitors may download everything held about them. */
  visitorCanExport?: boolean;
  /**
   * Visitor conversations may be summarised into the agent's shared
   * memory. Off by default: that memory is read back into answers for
   * everyone, so one visitor's words would surface in another's reply.
   */
  visitorMemory?: boolean;
}

/** Who can use the agent's channels, and what they may cost and keep. */
export interface VisitorRules {
  authMode?: VisitorAuthMode;
  limits?: VisitorLimits | null;
  privacy?: VisitorPrivacy | null;
}

export const VISITOR_PRIVACY_DEFAULTS: Required<VisitorPrivacy> = {
  retentionDays: null,
  visitorCanDelete: true,
  visitorCanExport: true,
  visitorMemory: false,
};

/** Effective privacy: stored values over the defaults. */
export function visitorPrivacyFrom(privacy: VisitorPrivacy | null | undefined): Required<VisitorPrivacy> {
  return {
    retentionDays:
      typeof privacy?.retentionDays === 'number' && Number.isFinite(privacy.retentionDays) && privacy.retentionDays > 0
        ? Math.floor(privacy.retentionDays)
        : null,
    visitorCanDelete: privacy?.visitorCanDelete ?? VISITOR_PRIVACY_DEFAULTS.visitorCanDelete,
    visitorCanExport: privacy?.visitorCanExport ?? VISITOR_PRIVACY_DEFAULTS.visitorCanExport,
    visitorMemory: privacy?.visitorMemory ?? VISITOR_PRIVACY_DEFAULTS.visitorMemory,
  };
}

/** What a download may do on the machine it runs on. Off unless granted. */
export interface ChannelCapabilities {
  filesystemRead?: string[];
  filesystemWrite?: string[];
  shell?: boolean;
  network?: boolean;
  requireApprovalFor?: string[];
}

@Entity('agent_channels')
@Index('IDX_agent_channels_org_agent', ['organizationId', 'agentId'])
@Index('IDX_agent_channels_gatewayId', ['gatewayId'])
export class AgentChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'uuid' })
  agentId: string;

  @Column({ type: 'varchar' })
  type: ChannelType;

  @Column({ type: 'varchar', default: ChannelStatus.DRAFT })
  status: ChannelStatus;

  /**
   * What the owner calls it, unique among the agent's channels, so two
   * channels of one type (a Slack for support, a Slack for sales) can be
   * told apart. Starts as the type's label.
   */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /**
   * The channel's address name: the web chat's subdomain, and the file
   * and executable name of a desktop or terminal app. Null for the rest.
   */
  @Column({ type: 'varchar', nullable: true })
  slug: string | null;

  /** The gateway a channel served by us answers on, once published. */
  @Column({ type: 'uuid', nullable: true })
  gatewayId: string | null;

  /**
   * What the medium needs: a reference to the credential holding the
   * platform keys (`credentialId`, `credentialKeys`) and the platform's
   * non-secret settings, a bundle id, what a download may touch
   * (`capabilities`), the web chat a desktop app opens
   * (`webChatChannelId`). Never a secret value.
   */
  @Column({ type: 'json', nullable: true })
  configuration: Record<string, any> | null;

  /** Overrides of the agent's branding for this channel only. Null inherits all of it. */
  @Column({ type: 'json', nullable: true })
  branding: ChannelBranding | null;

  /** Overrides of the agent's visitor rules for this channel only. Null inherits all of them. */
  @Column({ type: 'json', nullable: true })
  visitorRules: VisitorRules | null;

  /** What the last recorded build of a download produced. */
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

  @ManyToOne(() => Agent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agentId' })
  agent: Agent;
}
