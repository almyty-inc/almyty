import { apiGet, apiPost, apiPatch, apiDel, getApiBaseUrl } from './api'
import { hostedChatBaseDomain } from './tenant-host'

/**
 * Channels on an agent: where people, or other agents, reach it.
 *
 * An agent has many channels and a channel has exactly one agent: the web
 * chat link, the website widget, each messaging platform, A2A, and the
 * desktop and terminal apps people download. The agent's branding and
 * visitor rules apply to all of them, and any channel can override them.
 * Channels are added and edited on the agent's Channels tab only.
 */

export type VisitorAuthMode = 'public_link' | 'email_otp' | 'oauth' | 'sso'

export type ChannelType =
  | 'web'
  | 'widget'
  | 'a2a'
  | 'tui'
  | 'desktop'
  | 'binary'
  | 'slack'
  | 'discord'
  | 'telegram'
  | 'whatsapp'
  | 'whatsapp_cloud'
  | 'sms'
  | 'microsoft_teams'
  | 'google_chat'
  | 'email'
  | 'signal'
  | 'matrix'
  | 'irc'
  | 'webhook'

/** Channels backed by a messaging platform, each needing that platform's keys. */
export const MESSAGING_CHANNEL_TYPES: ChannelType[] = [
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'whatsapp_cloud',
  'sms',
  'microsoft_teams',
  'google_chat',
  'email',
  'signal',
  'matrix',
  'irc',
  'webhook',
]

export function isMessagingChannel(type: ChannelType): boolean {
  return MESSAGING_CHANNEL_TYPES.includes(type)
}

/**
 * The channels offered when adding one, in this order. A standalone
 * binary is not offered: it compiles to the same file as the terminal
 * app. One added before still shows and works.
 */
export const ADDABLE_CHANNEL_TYPES: ChannelType[] = [
  'web',
  'widget',
  'slack',
  'whatsapp',
  'whatsapp_cloud',
  'microsoft_teams',
  'telegram',
  'discord',
  'google_chat',
  'signal',
  'matrix',
  'irc',
  'email',
  'sms',
  'webhook',
  'desktop',
  'tui',
  'a2a',
]

export type ChannelStatus = 'draft' | 'building' | 'built' | 'live' | 'failed'

export interface ChannelBranding {
  appName?: string
  primaryColor?: string
  logoUrl?: string | null
  iconUrl?: string | null
  greeting?: string
  theme?: 'dark' | 'light' | 'auto'
  suggestedPrompts?: string[]
  aiDisclosure?: string | null
  whiteLabel?: boolean
}

export interface VisitorLimits {
  costCapCents?: number | null
  perUserRateLimit?: number | null
  perIpRateLimit?: number | null
  /** Spend per UTC day, in cents. Missing = the default; null = none. */
  dailySpendCapCents?: number | null
  /** Spend per UTC month, in cents. Missing = the default; null = none. */
  monthlySpendCapCents?: number | null
}

export interface VisitorPrivacy {
  /** Null inherits the organization policy; a value may only shorten it. */
  retentionDays?: number | null
  visitorCanDelete?: boolean
  visitorCanExport?: boolean
  /** Shared agent memory may include visitor conversations. */
  visitorMemory?: boolean
}

export interface VisitorRules {
  authMode?: VisitorAuthMode
  limits?: VisitorLimits | null
  privacy?: VisitorPrivacy | null
}

export interface ChannelCapabilities {
  filesystemRead?: string[]
  filesystemWrite?: string[]
  shell?: boolean
  network?: boolean
  requireApprovalFor?: string[]
}

export interface SpendCaps {
  dailyCents: number | null
  monthlyCents: number | null
}

/** What a channel's branding and visitor rules come to, the agent's with the channel's own over them. */
export interface EffectiveSettings {
  branding: ChannelBranding & { appName: string }
  visitorRules: {
    authMode: VisitorAuthMode
    limits: VisitorLimits
    privacy: Required<VisitorPrivacy>
    caps: SpendCaps
    /** The channel sets its own spend cap, so spends outside the agent's allowance. */
    ownSpend: boolean
  }
}

export interface AgentChannel {
  id: string
  agentId: string
  type: ChannelType
  status: ChannelStatus
  /** The web chat's address, or a download's file name. */
  slug: string | null
  gatewayId: string | null
  /** Where the channel answers (its gateway's endpoint). */
  endpoint: string
  /** Its keys come from a credential picked on Credentials, rather than keys entered on the channel. */
  credentialPicked?: boolean
  configuration?: Record<string, any> | null
  /** This channel's own branding; null uses the agent's. */
  branding: ChannelBranding | null
  /** This channel's own visitor rules; null uses the agent's. */
  visitorRules: VisitorRules | null
  effective: EffectiveSettings
  lastBuild?: {
    version?: string
    platform?: string
    checksum?: string
    signed?: boolean
    builtAt?: string
    builtBy?: string
    error?: string
  } | null
  createdAt?: string
}

/** The agent's public settings: what every channel inherits. */
export interface PublicSettings {
  branding: ChannelBranding | null
  visitorRules: VisitorRules | null
  effective: EffectiveSettings
}

export interface ChannelCheck {
  ok: boolean
  refusals: Array<{ code: string; message: string }>
}

/** What each channel is called. */
export const CHANNEL_LABELS: Record<ChannelType, string> = {
  web: 'Web chat',
  widget: 'Website widget',
  a2a: 'Other agents (A2A)',
  tui: 'Terminal app',
  desktop: 'Desktop app',
  // Kept so one added before still renders; not offered when adding.
  binary: 'Standalone binary',
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp (Twilio)',
  whatsapp_cloud: 'WhatsApp (Meta Cloud)',
  sms: 'SMS',
  microsoft_teams: 'Microsoft Teams',
  google_chat: 'Google Chat',
  email: 'Email',
  signal: 'Signal',
  matrix: 'Matrix',
  irc: 'IRC',
  webhook: 'Webhook',
}

/** One line under each tile when adding a channel. */
export const CHANNEL_HINTS: Record<ChannelType, string> = {
  web: 'A link people open',
  widget: 'A snippet for your website',
  a2a: 'Over A2A',
  tui: 'A command to download',
  desktop: 'An app to download',
  binary: 'One executable',
  slack: 'In your workspace',
  discord: 'As a bot',
  telegram: 'As a bot',
  whatsapp: 'Via Twilio',
  whatsapp_cloud: 'Via Meta Cloud',
  sms: 'Via Twilio',
  microsoft_teams: 'As a bot',
  google_chat: 'In your spaces',
  email: 'Via Resend',
  signal: 'Through your bridge',
  matrix: 'Through your bridge',
  irc: 'Through your bridge',
  webhook: 'To your own endpoint',
}

/** One sentence under a channel's title: what it does, said once. */
export const CHANNEL_DESCRIPTIONS: Record<ChannelType, string> = {
  web: 'A chat page on its own link, hosted by almyty.',
  widget: 'A chat bubble on your own website, added with one line of code.',
  a2a: 'Other agents find it by its agent card and call it over A2A.',
  tui: 'A command your users download and run in a terminal.',
  desktop: 'An installable app for macOS, Windows and Linux.',
  binary: 'A single executable with no runtime to install.',
  slack: 'Answers direct messages and mentions in your Slack workspace.',
  discord: 'Answers in your Discord server as a bot.',
  telegram: 'Answers as a Telegram bot.',
  whatsapp: 'Answers messages to your Twilio WhatsApp sender.',
  whatsapp_cloud: 'Answers messages to your business number through Meta\u2019s Cloud API.',
  sms: 'Answers text messages to your Twilio number.',
  microsoft_teams: 'Answers as a bot in Microsoft Teams.',
  google_chat: 'Answers as a Chat app in your Google Workspace spaces.',
  email: 'Answers email sent to your receiving address, through Resend.',
  signal: 'Answers on Signal through a bridge you run.',
  matrix: 'Answers in a Matrix room through a bridge you run.',
  irc: 'Answers in an IRC channel through a bridge you run.',
  webhook: 'Takes messages from, and sends replies to, an endpoint you own.',
}

/** Channels built into a download rather than served. */
export const BUILDABLE_CHANNEL_TYPES: ChannelType[] = ['tui', 'desktop', 'binary']

export function isBuildable(type: ChannelType): boolean {
  return BUILDABLE_CHANNEL_TYPES.includes(type)
}

/** Downloads that are installed, and so need an app ID. */
export const PACKAGED_CHANNEL_TYPES: ChannelType[] = ['desktop', 'binary', 'tui']

export const AUTH_MODE_LABELS: Record<VisitorAuthMode, string> = {
  public_link: 'Anyone with the link',
  email_otp: 'Email verification',
  oauth: 'Sign in with OAuth',
  sso: 'Enterprise SSO',
}

/** "Who can use it: ...", in the words of the one-line summary. */
export const AUTH_MODE_SUMMARY: Record<VisitorAuthMode, string> = {
  public_link: 'anyone with the link',
  email_otp: 'anyone who confirms their email',
  oauth: 'people who sign in with your provider',
  sso: "people in your organization's SSO",
}

/** One short line under each choice. */
export const AUTH_MODE_HINTS: Record<VisitorAuthMode, string> = {
  public_link: 'No sign-in',
  email_otp: 'A code by email',
  oauth: 'Google, Microsoft, GitHub',
  sso: 'Your own SSO',
}

/**
 * True when anyone holding the link or the download can use it. Only SSO
 * keeps a stranger out; an unset mode reads as open.
 */
export function isOpenToAnyone(authMode: VisitorAuthMode | undefined | null): boolean {
  return (authMode ?? 'public_link') !== 'sso'
}

export function grantsLocalAccess(capabilities: ChannelCapabilities | null | undefined): boolean {
  if (!capabilities) return false
  return (
    capabilities.shell === true ||
    (capabilities.filesystemRead?.length ?? 0) > 0 ||
    (capabilities.filesystemWrite?.length ?? 0) > 0
  )
}

export interface BuildPlatform {
  id: string
  label: string
  extension: string
  unsignedConsequence: string
  signing: {
    kind: 'authenticode' | 'apple'
    needs: string[]
    note: string
  } | null
}

export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed'

/** What a recipient of a download will meet, and the command that gets past it. */
export interface BuildHandoff {
  summary: string
  command: string | null
  commandNote: string | null
}

export interface AppBuild {
  id: string
  target: ChannelType
  platform: string
  status: BuildStatus
  version: string | null
  signed: boolean
  /** Why it is unsigned, when it could have been signed. */
  signingNote: string | null
  handoff?: BuildHandoff | null
  artifactBytes: string | null
  checksum: string | null
  error: string | null
  createdAt: string
  finishedAt: string | null
  artifactExpiresAt: string | null
}

export interface BuildCapabilities {
  canBuild: boolean
  buildReason: string | null
  signing: Array<{ kind: 'apple' | 'authenticode'; ready: boolean; reason: string | null }>
}

/** Human size for a download, whose byte count arrives as a string. */
export function formatBytes(bytes: string | null): string {
  const value = Number(bytes ?? 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  const mb = value / 1_000_000
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(value / 1000)} kB`
}

/** Cents as the owner reads money: "$5", "$0.50". */
export function formatCents(cents: number): string {
  const dollars = cents / 100
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`
}

/** What an allowance has spent against its caps. */
export interface SpendStatus {
  caps: SpendCaps
  todayCents: number
  monthCents: number
  /** The cap currently reached; visitors are told it has reached its limit. */
  reached: 'day' | 'month' | null
  resetsAt: string | null
}

/**
 * One setting a messaging channel asks for.
 *
 * `hint` is the one line that says where in the platform's own console
 * the value lives -- the question every one of these fields raised when
 * it was a bare label. `secret` values are masked as they are typed;
 * everything here, secret or not, is kept away from password managers,
 * which otherwise filled a dashboard login into the access-token field.
 */
export interface ChannelCredentialField {
  key: string
  label: string
  hint: string
  placeholder?: string
  /** Masked while typed, and never shown back once stored. */
  secret?: boolean
  /**
   * Required before the channel can go live. Mirrors
   * REQUIRED_CREDENTIALS in the backend (agent-channels/channel-publish.ts); an
   * optional field is one the adapter reads but publishing does not
   * insist on.
   */
  required?: boolean
  /** Shown under Advanced: an alternative most people do not need. */
  advanced?: boolean
}

const TWILIO_SID: ChannelCredentialField = {
  key: 'twilio_account_sid',
  label: 'Account SID',
  hint: 'Twilio Console → Account Info on the dashboard. It starts with AC.',
  placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  required: true,
}

const TWILIO_TOKEN: ChannelCredentialField = {
  key: 'twilio_auth_token',
  label: 'Auth token',
  hint: 'Twilio Console → Account Info → Auth Token.',
  secret: true,
  required: true,
}

/**
 * Signal, Matrix and IRC arrive through a bridge the customer runs, and
 * the adapters refuse a forwarded message that does not carry this token
 * (signal/matrix/irc.adapter.ts, `inbound_token`). Publishing does not
 * require it, so it is optional here, but without it nothing gets in.
 */
const BRIDGE_INBOUND_TOKEN: ChannelCredentialField = {
  key: 'inbound_token',
  label: 'Incoming token',
  hint: 'A random string you choose. The bridge sends it as a Bearer token with every message it forwards; without it incoming messages are refused.',
  secret: true,
}

/**
 * The settings each channel needs before it can carry a message.
 *
 * The required keys mirror REQUIRED_CREDENTIALS in the backend
 * (agent-channels/channel-publish.ts), kept in step by hand because it is a small
 * fixed table. The backend is the authority: it refuses to publish a
 * channel missing any of them, so a drift here only ever means an
 * extra or missing field, never a surface that ships unprotected.
 */
export const CHANNEL_CREDENTIAL_FIELDS: Partial<Record<ChannelType, ChannelCredentialField[]>> = {
  // "Add to Slack" first: with the Slack app's client id and secret any
  // workspace can install it and brings its own token. A bot token is the
  // one-workspace alternative (CREDENTIAL_ALTERNATIVES), under Advanced.
  slack: [
    {
      key: 'client_id',
      label: 'Client ID',
      hint: 'api.slack.com/apps → your app → Basic Information → App Credentials.',
      placeholder: '1234567890.1234567890',
    },
    {
      key: 'client_secret',
      label: 'Client secret',
      hint: 'Next to the Client ID, under App Credentials.',
      secret: true,
    },
    {
      key: 'signing_secret',
      label: 'Signing secret',
      hint: 'Under App Credentials too. Used to check that events really come from Slack.',
      secret: true,
      required: true,
    },
    {
      key: 'bot_token',
      label: 'Bot token',
      hint: 'Only for one workspace, instead of Add to Slack: OAuth & Permissions → Bot User OAuth Token.',
      placeholder: 'xoxb-...',
      secret: true,
      advanced: true,
    },
  ],
  discord: [
    {
      key: 'bot_token',
      label: 'Bot token',
      hint: 'discord.com/developers/applications → your app → Bot → Reset Token. Turn on the Message Content intent on the same page.',
      secret: true,
      required: true,
    },
  ],
  telegram: [
    {
      key: 'bot_token',
      label: 'Bot token',
      hint: 'Message @BotFather in Telegram, send /newbot, and copy the token it replies with.',
      placeholder: '123456789:AA...',
      secret: true,
      required: true,
    },
  ],
  whatsapp: [
    TWILIO_SID,
    TWILIO_TOKEN,
    {
      key: 'phone_number',
      label: 'WhatsApp sender',
      hint: 'Twilio Console → Messaging → Senders → WhatsApp senders, written as whatsapp:+15551234567.',
      placeholder: 'whatsapp:+15551234567',
      required: true,
    },
  ],
  whatsapp_cloud: [
    {
      key: 'access_token',
      label: 'Access token',
      hint: 'Meta for Developers → your app → WhatsApp → API Setup. For production, a permanent system-user token from Business Settings.',
      secret: true,
      required: true,
    },
    {
      key: 'phone_number_id',
      label: 'Phone number ID',
      hint: 'Meta for Developers → your app → WhatsApp → API Setup, under the sending number. An ID, not the phone number itself.',
      placeholder: '109876543210987',
      required: true,
    },
    {
      key: 'app_secret',
      label: 'App secret',
      hint: 'Meta for Developers → your app → App settings → Basic → App secret. Used to check that incoming messages really come from Meta.',
      secret: true,
      required: true,
    },
    {
      key: 'verify_token',
      label: 'Verify token',
      hint: 'Any phrase you choose. Enter the same phrase next to the callback URL in Meta’s webhook settings.',
      required: true,
    },
  ],
  sms: [
    TWILIO_SID,
    TWILIO_TOKEN,
    {
      key: 'phone_number',
      label: 'Twilio phone number',
      hint: 'Twilio Console → Phone Numbers → Active numbers, written as +15551234567.',
      placeholder: '+15551234567',
      required: true,
    },
  ],
  email: [
    {
      key: 'resend_api_key',
      label: 'Resend API key',
      hint: 'resend.com → API Keys → Create API key. It starts with re_.',
      placeholder: 're_...',
      secret: true,
      required: true,
    },
    {
      key: 'inbound_address',
      label: 'Receiving address',
      hint: 'The address people write to. Its domain must receive mail through Resend (resend.com → Domains).',
      placeholder: 'support@yourdomain.com',
      required: true,
    },
    {
      key: 'reply_from',
      label: 'Reply-from address',
      hint: 'Replies are sent from this address, on a domain verified in resend.com → Domains.',
      placeholder: 'support@yourdomain.com',
      required: true,
    },
  ],
  webhook: [
    {
      key: 'callback_url',
      label: 'Reply URL',
      hint: 'Your own endpoint. Each reply is POSTed here as JSON.',
      placeholder: 'https://your-server.example.com/almyty',
      required: true,
    },
    {
      key: 'secret',
      label: 'Shared secret',
      hint: 'A random string you choose. Sign what you send with HMAC-SHA256 in the X-Webhook-Signature header; replies are signed the same way.',
      secret: true,
      required: true,
    },
  ],
  google_chat: [
    {
      key: 'webhook_url',
      label: 'Space webhook URL',
      hint: 'In Google Chat, open the space → Apps & integrations → Webhooks → Add webhook, and copy its URL. Replies are posted here.',
      placeholder: 'https://chat.googleapis.com/v1/spaces/...',
      secret: true,
      required: true,
    },
    {
      key: 'verification_token',
      label: 'Verification token',
      hint: 'Google Cloud console → APIs & Services → Google Chat API → Configuration. Every event must carry it as a Bearer token.',
      secret: true,
      required: true,
    },
  ],
  microsoft_teams: [
    {
      key: 'bot_id',
      label: 'Microsoft App ID',
      hint: 'Azure portal → your Azure Bot → Configuration → Microsoft App ID.',
      placeholder: '00000000-0000-0000-0000-000000000000',
      required: true,
    },
    {
      key: 'bot_password',
      label: 'Client secret',
      hint: 'Azure portal → the bot’s app registration → Certificates & secrets → New client secret. Copy the Value, not the ID.',
      secret: true,
      required: true,
    },
    {
      key: 'service_url',
      label: 'Service URL',
      hint: 'Where replies go when a message does not say. Usually https://smba.trafficmanager.net/teams/.',
      placeholder: 'https://smba.trafficmanager.net/teams/',
      required: true,
    },
  ],
  signal: [
    {
      key: 'api_url',
      label: 'Bridge URL',
      hint: 'The address of your signal-cli-rest-api bridge.',
      placeholder: 'http://signal-cli:8080',
      required: true,
    },
    {
      key: 'phone_number',
      label: 'Signal number',
      hint: 'The number registered with the bridge, written as +15551234567.',
      placeholder: '+15551234567',
      required: true,
    },
    BRIDGE_INBOUND_TOKEN,
  ],
  matrix: [
    {
      key: 'homeserver_url',
      label: 'Homeserver URL',
      hint: 'Where the bot account lives.',
      placeholder: 'https://matrix.org',
      required: true,
    },
    {
      key: 'access_token',
      label: 'Access token',
      hint: 'Sign in as the bot in Element → Settings → Help & About → Access token.',
      secret: true,
      required: true,
    },
    {
      key: 'room_id',
      label: 'Room ID',
      hint: 'Element → the room → Settings → Advanced → Internal room ID. It starts with !.',
      placeholder: '!abcdef:matrix.org',
      required: true,
    },
    BRIDGE_INBOUND_TOKEN,
  ],
  irc: [
    {
      key: 'webhook_url',
      label: 'Bridge URL',
      hint: 'Your IRC bridge’s HTTP endpoint (matterbridge in API mode, or similar). Replies are POSTed here.',
      placeholder: 'https://irc-bridge.example.com/api/message',
      required: true,
    },
    {
      key: 'bridge_token',
      label: 'Reply token',
      hint: 'Sent to the bridge as a Bearer token with every reply. Use whatever token your bridge checks.',
      secret: true,
      required: true,
    },
    {
      key: 'nick',
      label: 'Nick',
      hint: 'The nick the bot speaks as.',
      placeholder: 'acme-bot',
      required: true,
    },
    {
      key: 'channel',
      label: 'Channel',
      hint: 'Where replies go when a message does not say.',
      placeholder: '#support',
      required: true,
    },
    BRIDGE_INBOUND_TOKEN,
  ],
}

/**
 * How a platform learns where to deliver messages.
 *
 *  - manual: the operator pastes our URL into the platform's console.
 *  - auto:   publishing registers it (Telegram setWebhook, the Twilio
 *            number's messaging webhook -- channel-webhook-registrar.ts).
 *  - none:   nothing calls us: a download, the web chat, or
 *            Discord, whose messages arrive over the gateway websocket
 *            almyty opens (discord-gateway.transport.ts).
 */
export type InboundMode = 'manual' | 'auto' | 'none'

export interface ChannelInbound {
  mode: InboundMode
  /** What to do with the URL, in the platform's own words. */
  where?: string
  /** Why no URL is needed (mode 'none'). */
  why?: string
  /** The URL is the shared email route rather than the channel's own. */
  sharedEmailRoute?: boolean
}

export const CHANNEL_INBOUND: Record<ChannelType, ChannelInbound> = {
  web: { mode: 'none', why: 'almyty hosts the web chat, so there is nothing to register.' },
  tui: { mode: 'none', why: 'A terminal app is a file people download; nothing calls back.' },
  desktop: { mode: 'none', why: 'A desktop app is a file people download; nothing calls back.' },
  binary: { mode: 'none', why: 'A binary is a file people download; nothing calls back.' },
  widget: { mode: 'none', why: 'the widget talks to almyty from your page, so there is nothing to register.' },
  a2a: { mode: 'none', why: 'other agents call almyty at the address below.' },
  discord: {
    mode: 'none',
    why: 'almyty connects out to Discord’s gateway, so there is no URL to register.',
  },
  slack: {
    mode: 'manual',
    where: 'Paste it into api.slack.com/apps → your app → Event Subscriptions → Request URL, then subscribe to the message.im and app_mention bot events.',
  },
  telegram: {
    mode: 'auto',
    where: 'Registered with Telegram for you when you publish. Shown here in case you need to check it.',
  },
  whatsapp: {
    mode: 'auto',
    where: 'Set on your Twilio number for you when you publish. Shown here in case you need to check it.',
  },
  sms: {
    mode: 'auto',
    where: 'Set on your Twilio number for you when you publish. Shown here in case you need to check it.',
  },
  whatsapp_cloud: {
    mode: 'manual',
    where: 'Meta for Developers → your app → WhatsApp → Configuration → Webhook: paste this as the Callback URL with the verify token above, then subscribe to the messages field. Meta checks it straight away, so publish first.',
  },
  microsoft_teams: {
    mode: 'manual',
    where: 'Azure portal → your Azure Bot → Configuration → Messaging endpoint.',
  },
  google_chat: {
    mode: 'manual',
    where: 'Google Cloud console → Google Chat API → Configuration → Connection settings: choose HTTP endpoint URL and paste this.',
  },
  email: {
    mode: 'manual',
    sharedEmailRoute: true,
    where: 'resend.com → Webhooks → Add endpoint, for received email. One endpoint serves every email channel; mail is matched to this one by its receiving address.',
  },
  signal: {
    mode: 'manual',
    where: 'Set this as your bridge’s receive webhook, sending the incoming token above as a Bearer token.',
  },
  matrix: {
    mode: 'manual',
    where: 'Point your Matrix bridge at this URL to forward room messages, sending the incoming token above as a Bearer token.',
  },
  irc: {
    mode: 'manual',
    where: 'Set this as your bridge’s outgoing webhook, sending the incoming token above as a Bearer token.',
  },
  webhook: {
    mode: 'manual',
    where: 'Your system POSTs incoming messages here, signed with the shared secret above.',
  },
}

/**
 * The URL a platform delivers messages to for this channel: its endpoint
 * on the unified endpoint under the organization, `<api>/<org>/<endpoint>`,
 * the same URL the webhook registrar hands Telegram and Twilio. Email is
 * the exception: Resend allows one inbound webhook per account, so every
 * email channel shares `/channels/email/inbound` and is matched by its
 * receiving address.
 */
export function channelCallbackUrl(apiBase: string, orgSlug: string, channel: Pick<AgentChannel, 'type' | 'endpoint'>): string | null {
  const inbound = CHANNEL_INBOUND[channel.type]
  if (!inbound || inbound.mode === 'none') return null
  const base = apiBase.replace(/\/+$/, '')
  if (inbound.sharedEmailRoute) return `${base}/channels/email/inbound`
  return `${base}/${orgSlug}/${channel.endpoint.replace(/^\/+/, '')}`
}

/**
 * Keys that stand in for others, mirroring CREDENTIAL_ALTERNATIVES in the
 * backend. A Slack channel carries either its Slack app's client id and
 * secret, for "Add to Slack", or one bot token for a single workspace.
 */
export const CREDENTIAL_ALTERNATIVES: Partial<Record<ChannelType, { instead: string[]; all: string[] }>> = {
  slack: { instead: ['bot_token'], all: ['client_id', 'client_secret'] },
}

/** The fields still needed before a channel can go live. */
export function missingChannelFields(type: ChannelType, has: (key: string) => boolean): string[] {
  const fields = CHANNEL_CREDENTIAL_FIELDS[type] ?? []
  const alternative = CREDENTIAL_ALTERNATIVES[type]
  const replaced = alternative && alternative.all.every(has) ? alternative.instead : []
  const replaceable = alternative ? alternative.instead : []
  return fields
    .filter((f) => (f.required || replaceable.includes(f.key)) && !replaced.includes(f.key))
    .map((f) => f.key)
    .filter((key) => !has(key))
}

/** The connector a channel's keys are filed under on Credentials, e.g. `channel-slack`. */
export function channelConnectorKey(type: ChannelType): string {
  const gatewayType: Partial<Record<ChannelType, string>> = { web: 'hosted_chat', widget: 'chat_widget' }
  return `channel-${(gatewayType[type] ?? type).replace(/_/g, '-')}`
}

/** The address a published web chat answers on: its slug, as a subdomain. */
export function webChatUrl(slug: string): string {
  return `https://${slug}.${hostedChatBaseDomain()}`
}

/** Where other agents reach an A2A channel: the JSON-RPC address and the agent card next to it. */
export function a2aAddresses(apiBase: string, orgSlug: string, endpoint: string): { endpoint: string; card: string } {
  const address = `${apiBase.replace(/\/+$/, '')}/${orgSlug}/${endpoint.replace(/^\/+/, '')}`
  return { endpoint: address, card: `${address}/.well-known/agent-card.json` }
}

/** The URL to register as the Slack app's redirect URL for "Add to Slack". */
export function slackInstallRedirectUrl(apiBase: string, gatewayId: string): string {
  return `${apiBase.replace(/\/+$/, '')}/gateways/${gatewayId}/install/slack/callback`
}

/** Mirrors BUNDLE_ID_PATTERN in the backend (channel-rules.ts). */
export const BUNDLE_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/

const unwrap = <T,>(payload: any): T => (payload?.data ?? payload) as T

const base = (agentId: string) => `/agents/${agentId}/channels`

export const agentChannelsApi = {
  list: (agentId: string) => apiGet(base(agentId)).then((r) => unwrap<AgentChannel[]>(r) ?? []),

  get: (agentId: string, channelId: string) =>
    apiGet(`${base(agentId)}/${channelId}`).then((r) => unwrap<AgentChannel>(r)),

  add: (
    agentId: string,
    body: { type: ChannelType; slug?: string; configuration?: Record<string, any>; credentialId?: string | null },
  ) => apiPost(base(agentId), body).then((r) => unwrap<AgentChannel>(r)),

  /**
   * Change a channel. Send only what changed: the backend merges into the
   * stored settings, and a masked key sent back is ignored, never stored.
   */
  update: (
    agentId: string,
    channelId: string,
    body: {
      configuration?: Record<string, any>
      credentialId?: string | null
      branding?: ChannelBranding | null
      visitorRules?: VisitorRules | null
    },
  ) => apiPatch(`${base(agentId)}/${channelId}`, body).then((r) => unwrap<AgentChannel>(r)),

  remove: (agentId: string, channelId: string) => apiDel(`${base(agentId)}/${channelId}`),

  /** What is stopping this channel from going live or being built, while it is still editable. */
  check: (agentId: string, channelId: string) =>
    apiGet(`${base(agentId)}/${channelId}/check`).then((r) => unwrap<ChannelCheck>(r)),

  publish: (agentId: string, channelId: string) =>
    apiPost(`${base(agentId)}/${channelId}/publish`, {}).then((r) => unwrap<AgentChannel>(r)),

  /** Stop it answering, keeping its settings and its address. */
  unpublish: (agentId: string, channelId: string) =>
    apiPost(`${base(agentId)}/${channelId}/unpublish`, {}).then((r) => unwrap<AgentChannel>(r)),

  platforms: (agentId: string, channelId: string) =>
    apiGet(`${base(agentId)}/${channelId}/platforms`).then((r) => unwrap<BuildPlatform[]>(r)),

  /** What this deployment can build and sign, read before offering a Build button. */
  capabilities: (agentId: string, channelId: string) =>
    apiGet(`${base(agentId)}/${channelId}/capabilities`).then((r) => unwrap<BuildCapabilities>(r)),

  requestBuild: (
    agentId: string,
    channelId: string,
    body: { platform: string; version?: string; macPackaging?: 'zip' | 'dmg' },
  ) => apiPost(`${base(agentId)}/${channelId}/builds`, body).then((r) => unwrap<AppBuild>(r)),

  builds: (agentId: string, channelId: string) =>
    apiGet(`${base(agentId)}/${channelId}/builds`).then((r) => unwrap<AppBuild[]>(r) ?? []),

  /**
   * Where to fetch a finished download. Object storage answers with its own
   * absolute URL; a deployment that cannot presign answers with a path on
   * the API, resolved against the API host rather than the dashboard.
   */
  downloadUrl: (agentId: string, channelId: string, buildId: string) =>
    apiGet(`${base(agentId)}/${channelId}/builds/${buildId}/download`).then((r) => {
      const url = unwrap<{ url: string }>(r).url
      return /^https?:\/\//.test(url) ? url : `${getApiBaseUrl()}${url}`
    }),

  publicSettings: (agentId: string) =>
    apiGet(`/agents/${agentId}/public-settings`).then((r) => unwrap<PublicSettings>(r)),

  updatePublicSettings: (agentId: string, body: { branding?: ChannelBranding | null; visitorRules?: VisitorRules | null }) =>
    apiPatch(`/agents/${agentId}/public-settings`, body).then((r) => unwrap<PublicSettings>(r)),

  /** What the agent's shared allowance, and each channel with its own, has spent. */
  spend: (agentId: string) =>
    apiGet(`/agents/${agentId}/public-settings/spend`).then((r) =>
      unwrap<{ agent: SpendStatus; channels: Array<{ channelId: string; status: SpendStatus }> }>(r),
    ),
}

/** The agent channel a gateway answers for, as the gateway page shows it. */
export interface GatewayManagedBy {
  agent: { id: string; name: string }
  channel: { id: string; type: ChannelType }
}

export const channelLinkApi = {
  /** The channel a gateway answers for, or null for one no channel owns. */
  channelForGateway: (gatewayId: string) =>
    apiGet(`/gateways/${gatewayId}/channel`).then((r: any) => (r?.data !== undefined ? r.data : r) as GatewayManagedBy | null),
}
