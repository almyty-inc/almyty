import { apiGet, apiPost, apiPatch, apiDel, getApiBaseUrl } from './api'
import { hostedChatBaseDomain } from './tenant-host'

/**
 * The agent factory client.
 *
 * An app is the product a customer ships: several agents under one
 * name, with the branding they appear under, who may use them, and what
 * a downloadable artifact may touch on the machine it runs on.
 * Distributions are that product rendered for different places.
 */

export type AppAuthMode = 'public_link' | 'email_otp' | 'oauth' | 'sso'

/**
 * Where an app ships. Messaging platforms are named individually rather
 * than collapsed into one "channel" target: an app ships to Slack, not
 * to an abstraction, and naming the platform is what makes each
 * distribution addressable as /apps/acme/distributions/slack.
 */
export type DistributionTarget =
  | 'web'
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

/** Targets backed by a messaging gateway holding platform credentials. */
export const CHANNEL_TARGETS: DistributionTarget[] = [
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

export function isChannelTarget(target: DistributionTarget): boolean {
  return CHANNEL_TARGETS.includes(target)
}

export type DistributionStatus = 'draft' | 'building' | 'built' | 'live' | 'failed'

export interface AppBranding {
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

export interface AppCapabilities {
  filesystemRead?: string[]
  filesystemWrite?: string[]
  shell?: boolean
  network?: boolean
  requireApprovalFor?: string[]
}

export interface AppPrivacy {
  /** Null inherits the organization policy; an override may only shorten it. */
  retentionDays?: number | null
  visitorCanDelete?: boolean
  visitorCanExport?: boolean
  /** Shared agent memory may include hosted-chat visitor conversations. */
  visitorMemory?: boolean
}

export const APP_PRIVACY_DEFAULTS: Required<AppPrivacy> = {
  retentionDays: null,
  visitorCanDelete: true,
  visitorCanExport: true,
  visitorMemory: false,
}

/** Effective values for old apps and partially populated API responses. */
export function appPrivacyFrom(privacy: AppPrivacy | null | undefined): Required<AppPrivacy> {
  return {
    retentionDays:
      typeof privacy?.retentionDays === 'number' &&
      Number.isFinite(privacy.retentionDays) &&
      privacy.retentionDays > 0
        ? Math.floor(privacy.retentionDays)
        : null,
    visitorCanDelete: privacy?.visitorCanDelete ?? APP_PRIVACY_DEFAULTS.visitorCanDelete,
    visitorCanExport: privacy?.visitorCanExport ?? APP_PRIVACY_DEFAULTS.visitorCanExport,
    visitorMemory: privacy?.visitorMemory ?? APP_PRIVACY_DEFAULTS.visitorMemory,
  }
}

export interface AppDistribution {
  id: string
  appId: string
  target: DistributionTarget
  status: DistributionStatus
  gatewayId: string | null
  configuration?: Record<string, any> | null
  lastBuild?: {
    version?: string
    platform?: string
    checksum?: string
    signed?: boolean
    builtAt?: string
    builtBy?: string
    error?: string
  } | null
}

export interface AgentApp {
  id: string
  name: string
  slug: string
  description: string | null
  agentIds: string[]
  branding: AppBranding | null
  authMode: AppAuthMode
  capabilities: AppCapabilities | null
  limits: AppLimits | null
  privacy: AppPrivacy | null
  isActive: boolean
  distributions?: AppDistribution[]
  /** From the list endpoint: whether the app's agent last failed. */
  health?: AppHealth
}

export type AppHealth =
  | { state: 'ok' }
  | { state: 'failing'; agentId: string; agentName: string; at: string; message: string }


export interface AppCheck {
  ok: boolean
  refusals: Array<{ code: string; message: string }>
}

/**
 * What each target is, in the words an operator would use. Cards and
 * dialogs show these rather than the enum, because "binary" alone does
 * not tell anyone what they get.
 */
export const DISTRIBUTION_LABELS: Record<DistributionTarget, string> = {
  web: 'Web app',
  tui: 'Terminal app',
  desktop: 'Desktop app',
  // Kept so an existing distribution still renders. Not offered when
  // adding one: it compiles to the same artifact as 'tui'.
  binary: 'Standalone binary',
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp (Twilio)',
  whatsapp_cloud: 'WhatsApp (Meta)',
  sms: 'SMS',
  microsoft_teams: 'Microsoft Teams',
  google_chat: 'Google Chat',
  email: 'Email',
  signal: 'Signal',
  matrix: 'Matrix',
  irc: 'IRC',
  webhook: 'Webhook',
}

export const DISTRIBUTION_BLURBS: Record<DistributionTarget, string> = {
  web: 'A branded chat app on its own address',
  tui: 'A command your users run in a terminal',
  desktop: 'An installable windowed app',
  binary: 'One executable, no runtime to install',
  slack: 'In your Slack workspace',
  discord: 'In your Discord server',
  telegram: 'As a Telegram bot',
  whatsapp: 'On WhatsApp through Twilio',
  whatsapp_cloud: "On WhatsApp through Meta's Cloud API",
  sms: 'Over SMS through Twilio',
  microsoft_teams: 'In Microsoft Teams',
  google_chat: 'In Google Chat',
  email: 'By email',
  signal: 'On Signal through your bridge',
  matrix: 'On Matrix through your bridge',
  irc: 'On IRC through your bridge',
  webhook: 'To any endpoint you own',
}

/**
 * Targets that produce a file someone runs, so they need an identity.
 *
 * A terminal app is here too. It is not a bundle, but signing one on
 * macOS still needs an identifier: a bare executable has no Info.plist
 * to take one from, so without it every customer's binary identifies as
 * whatever the compiler happened to call it.
 */
export const PACKAGED_TARGETS: DistributionTarget[] = ['desktop', 'binary', 'tui']

export const AUTH_MODE_LABELS: Record<AppAuthMode, string> = {
  public_link: 'Anyone with the link',
  email_otp: 'Email verification',
  oauth: 'Sign in with OAuth',
  sso: 'Enterprise SSO',
}

/** "Who can use it: ..." for an app, in the words of the one-line summary. */
export const AUTH_MODE_SUMMARY: Record<AppAuthMode, string> = {
  public_link: 'anyone with the link',
  email_otp: 'anyone who confirms their email',
  oauth: 'people who sign in with your provider',
  sso: "people in your organization's SSO",
}

/** One short line under each choice. */
export const AUTH_MODE_HINTS: Record<AppAuthMode, string> = {
  public_link: 'No sign-in',
  email_otp: 'A code by email',
  oauth: 'Google, Microsoft, GitHub',
  sso: 'Your own SSO',
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

export interface AppBuild {
  id: string
  target: DistributionTarget
  platform: string
  status: BuildStatus
  version: string | null
  signed: boolean
  /** Why it is unsigned, when it could have been signed. */
  signingNote: string | null
  /** What to tell whoever this artifact is handed to. */
  handoff?: BuildHandoff | null
  artifactBytes: string | null
  checksum: string | null
  error: string | null
  createdAt: string
  finishedAt: string | null
  artifactExpiresAt: string | null
}

/** Targets that compile to a file someone downloads. */
export const BUILDABLE_TARGETS: DistributionTarget[] = ['tui', 'desktop', 'binary']

export function isBuildable(target: DistributionTarget): boolean {
  return BUILDABLE_TARGETS.includes(target)
}

/**
 * Whether publishing this target means standing up a surface.
 *
 * The three buildable targets produce a file someone downloads. There
 * is nothing to publish and nothing to take down; the artifact is the
 * whole of it.
 */
/**
 * One setting a messaging distribution asks for.
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
   * Required before the distribution can publish. Mirrors
   * REQUIRED_CREDENTIALS in the backend (distribution-publish.ts); an
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
 * (distribution-publish.ts), kept in step by hand because it is a small
 * fixed table. The backend is the authority: it refuses to publish a
 * distribution missing any of them, so a drift here only ever means an
 * extra or missing field, never a surface that ships unprotected.
 */
export const CHANNEL_CREDENTIAL_FIELDS: Partial<Record<DistributionTarget, ChannelCredentialField[]>> = {
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
 *  - none:   nothing calls us: a download, the hosted web app, or
 *            Discord, whose messages arrive over the gateway websocket
 *            almyty opens (discord-gateway.transport.ts).
 */
export type InboundMode = 'manual' | 'auto' | 'none'

export interface DistributionInbound {
  mode: InboundMode
  /** What to do with the URL, in the platform's own words. */
  where?: string
  /** Why no URL is needed (mode 'none'). */
  why?: string
  /** The URL is the shared email route rather than the surface's own. */
  sharedEmailRoute?: boolean
}

export const DISTRIBUTION_INBOUND: Record<DistributionTarget, DistributionInbound> = {
  web: { mode: 'none', why: 'almyty hosts the web app, so there is nothing to register.' },
  tui: { mode: 'none', why: 'A terminal app is a file people download; nothing calls back.' },
  desktop: { mode: 'none', why: 'A desktop app is a file people download; nothing calls back.' },
  binary: { mode: 'none', why: 'A binary is a file people download; nothing calls back.' },
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
    where: 'resend.com → Webhooks → Add endpoint, for received email. One endpoint serves every app on email; mail is matched to this one by its receiving address.',
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
 * The URL a platform delivers messages to for this distribution.
 *
 * Publishing creates a gateway whose endpoint is `/apps/<app>/<target>`
 * (endpointFor in the backend), served on the unified endpoint under the
 * organization: `<api>/<org>/apps/<app>/<target>` -- the same URL the
 * webhook registrar hands Telegram and Twilio. Email is the exception:
 * Resend allows one inbound webhook per account, so every email
 * distribution shares `/channels/email/inbound` and is matched by its
 * receiving address (channel-email-inbound.controller.ts).
 */
export function distributionCallbackUrl(
  apiBase: string,
  orgSlug: string,
  appSlug: string,
  target: DistributionTarget,
): string | null {
  const inbound = DISTRIBUTION_INBOUND[target]
  if (!inbound || inbound.mode === 'none') return null
  const base = apiBase.replace(/\/+$/, '')
  if (inbound.sharedEmailRoute) return `${base}/channels/email/inbound`
  return `${base}/${orgSlug}/apps/${appSlug}/${target}`
}

/** One sentence under a distribution's title: what it does, said once. */
export const DISTRIBUTION_DESCRIPTIONS: Record<DistributionTarget, string> = {
  web: 'A branded chat site on its own address, hosted by almyty.',
  tui: 'A command your users install and run in a terminal.',
  desktop: 'An installable windowed app for macOS, Windows and Linux.',
  binary: 'A single executable with no runtime to install.',
  slack: 'Answers direct messages and mentions in your Slack workspace.',
  discord: 'Answers in your Discord server as a bot.',
  telegram: 'Answers as a Telegram bot.',
  whatsapp: 'Answers messages to your Twilio WhatsApp sender.',
  whatsapp_cloud: 'Answers messages to your business number through Meta’s Cloud API.',
  sms: 'Answers text messages to your Twilio number.',
  microsoft_teams: 'Answers as a bot in Microsoft Teams.',
  google_chat: 'Answers as a Chat app in your Google Workspace spaces.',
  email: 'Answers email sent to your receiving address, through Resend.',
  signal: 'Answers on Signal through a bridge you run.',
  matrix: 'Answers in a Matrix room through a bridge you run.',
  irc: 'Answers in an IRC channel through a bridge you run.',
  webhook: 'Takes messages from, and sends replies to, an endpoint you own.',
}

export function servesOverGateway(target: DistributionTarget): boolean {
  return !isBuildable(target)
}

/** Human size for an artifact, whose byte count arrives as a string. */
export function formatBytes(bytes: string | null): string {
  const value = Number(bytes ?? 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  const mb = value / 1_000_000
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(value / 1000)} kB`
}

const unwrap = <T,>(payload: any): T => (payload?.data ?? payload) as T

export const agentAppsApi = {
  list: () => apiGet('/apps').then((r) => unwrap<AgentApp[]>(r)),

  getById: (id: string) => apiGet(`/apps/${id}`).then((r) => unwrap<AgentApp>(r)),

  /** What is stopping this product from shipping, while it is still editable. */
  check: (id: string) => apiGet(`/apps/${id}/check`).then((r) => unwrap<AppCheck>(r)),

  create: (data: Partial<AgentApp>) => apiPost('/apps', data).then((r) => unwrap<AgentApp>(r)),

  update: (id: string, data: Partial<AgentApp>) =>
    apiPatch(`/apps/${id}`, data).then((r) => unwrap<AgentApp>(r)),

  remove: (id: string) => apiDel(`/apps/${id}`),

  addDistribution: (
    id: string,
    target: DistributionTarget,
    configuration: Record<string, any> = {},
    gatewayId: string | null = null,
  ) =>
    apiPost(`/apps/${id}/distributions`, { target, configuration, gatewayId }).then((r) =>
      unwrap<AppDistribution>(r),
    ),

  // Addressed by app name plus the platform it ships to, matching the
  // API. There is one distribution per target, so that pair is enough
  // and no opaque id has to travel through the UI.
  checkDistribution: (slug: string, target: DistributionTarget) =>
    apiGet(`/apps/${slug}/distributions/${target}/check`).then((r) => unwrap<AppCheck>(r)),

  /** Make this distribution answer. */
  publishDistribution: (slug: string, target: DistributionTarget) =>
    apiPost(`/apps/${slug}/distributions/${target}/publish`, {}).then((r) =>
      unwrap<AppDistribution>(r),
    ),

  /** Stop it answering, keeping its settings and its endpoint. */
  unpublishDistribution: (slug: string, target: DistributionTarget) =>
    apiPost(`/apps/${slug}/distributions/${target}/unpublish`, {}).then((r) =>
      unwrap<AppDistribution>(r),
    ),

  removeDistribution: (slug: string, target: DistributionTarget) =>
    apiDel(`/apps/${slug}/distributions/${target}`),

  /**
   * What this deployment can build and sign for a target.
   *
   * Read before offering a Build button, so a host with no signing tool
   * says so rather than letting someone find out from a failed build.
   */
  capabilities: (slug: string, target: DistributionTarget) =>
    apiGet(`/apps/${slug}/distributions/${target}/capabilities`).then((r) =>
      unwrap<BuildCapabilities>(r),
    ),

  /** Platforms this target can be built for, and what signing each needs. */
  platforms: (slug: string, target: DistributionTarget) =>
    apiGet(`/apps/${slug}/distributions/${target}/platforms`).then((r) =>
      unwrap<BuildPlatform[]>(r),
    ),

  requestBuild: (
    slug: string,
    body: { target: DistributionTarget; platform: string; version?: string; macPackaging?: 'zip' | 'dmg' },
  ) => apiPost(`/apps/${slug}/builds`, body).then((r) => unwrap<AppBuild>(r)),

  builds: (slug: string) => apiGet(`/apps/${slug}/builds`).then((r) => unwrap<AppBuild[]>(r)),

  /**
   * A fresh download link. Minted per request and short lived, so it is
   * fetched at click time rather than stored with the build.
   */
  /**
   * Where to fetch a finished artifact.
   *
   * Object storage answers with its own absolute URL. A deployment that
   * cannot presign answers with a path on the API, which has to be
   * resolved against the API host: opening it against the dashboard
   * origin would land on the SPA router instead of the file.
   */
  downloadUrl: (slug: string, buildId: string) =>
    apiGet(`/apps/${slug}/builds/${buildId}/download`).then((r) => {
      const url = unwrap<{ url: string }>(r).url
      return /^https?:\/\//.test(url) ? url : `${getApiBaseUrl()}${url}`
    }),

  recordBuild: (
    slug: string,
    target: DistributionTarget,
    build: { version?: string; platform?: string; checksum?: string; signed?: boolean; error?: string },
  ) =>
    apiPost(`/apps/${slug}/distributions/${target}/build`, build).then((r) =>
      unwrap<AppDistribution>(r),
    ),
}

/** True when the product grants any access to the machine it runs on. */
/**
 * What a stranger is allowed to cost.
 *
 * A product open to anyone cannot be published without these, because
 * an open product is a way to hand the customer's model keys to the
 * internet.
 */
/**
 * What a recipient of this artifact will meet, and the command that
 * gets past it when one exists.
 */
export interface BuildHandoff {
  summary: string
  command: string | null
  commandNote: string | null
}

export interface BuildCapabilities {
  canBuild: boolean
  buildReason: string | null
  signing: Array<{ kind: 'apple' | 'authenticode'; ready: boolean; reason: string | null }>
}

export interface AppLimits {
  costCapCents?: number | null
  perUserRateLimit?: number | null
  perIpRateLimit?: number | null
}

export function grantsLocalAccess(capabilities: AppCapabilities | null | undefined): boolean {
  if (!capabilities) return false
  return (
    capabilities.shell === true ||
    (capabilities.filesystemRead?.length ?? 0) > 0 ||
    (capabilities.filesystemWrite?.length ?? 0) > 0
  )
}

/**
 * True when anyone holding the link or the artifact can use it.
 * An unset mode reads as open, matching the backend: defaulting to
 * gated would let an unconfigured product skip the cost and rate
 * limit checks.
 */
export function isOpenToAnyone(authMode: AppAuthMode | undefined): boolean {
  return (authMode ?? 'public_link') === 'public_link'
}

/** Names an app cannot take, mirroring the backend list. */
const RESERVED_APP_SLUGS = [
  'www', 'api', 'app', 'admin', 'docs', 'status', 'staging', 'dev',
  'chat', 'mail', 'assets', 'static', 'cdn', 'download', 'install',
]

const APP_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Why this name is unusable, or null. Same wording as the API. */
export function appSlugError(slug: string): string | null {
  const value = (slug || '').trim().toLowerCase()
  if (!value) return 'Pick a name for the app.'
  if (value.length < 3) return 'Must be at least 3 characters.'
  if (value.length > 63) return 'Must be 63 characters or fewer.'
  if (!APP_SLUG_PATTERN.test(value)) {
    return 'Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.'
  }
  if (RESERVED_APP_SLUGS.includes(value)) return 'That name is reserved.'
  return null
}

/** Turn a display name into a usable address without making the user think. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

/** Every target the API accepts, so a route param can be checked. */
export function isDistributionTarget(value: string | undefined): value is DistributionTarget {
  return !!value && Object.prototype.hasOwnProperty.call(DISTRIBUTION_LABELS, value)
}

/**
 * Credentials that stand in for others, mirroring CREDENTIAL_ALTERNATIVES
 * in the backend (distribution-publish.ts). A Slack place carries either
 * its Slack app's client id and secret, for "Add to Slack", or one bot
 * token for a single workspace.
 */
export const CREDENTIAL_ALTERNATIVES: Partial<Record<DistributionTarget, { instead: string[]; all: string[] }>> = {
  slack: { instead: ['bot_token'], all: ['client_id', 'client_secret'] },
}

/**
 * The fields still needed before a place can go live: required ones
 * neither stored nor typed, less any an alternative already covers.
 */
export function missingChannelFields(
  target: DistributionTarget,
  has: (key: string) => boolean,
): string[] {
  const fields = CHANNEL_CREDENTIAL_FIELDS[target] ?? []
  const alternative = CREDENTIAL_ALTERNATIVES[target]
  const replaced = alternative && alternative.all.every(has) ? alternative.instead : []
  const replaceable = alternative ? alternative.instead : []
  return fields
    .filter((f) => (f.required || replaceable.includes(f.key)) && !replaced.includes(f.key))
    .map((f) => f.key)
    .filter((key) => !has(key))
}

/**
 * The bundle id a desktop or binary place starts with: the app's address
 * in the app.almyty namespace. Mirrors defaultBundleId in the backend
 * (agent-app.rules.ts), which seeds it when the place is added.
 */
export function defaultBundleId(slug: string): string {
  return `app.almyty.${slug.replace(/[^a-z0-9]+/gi, '').toLowerCase()}`
}

/** The address a published web app answers on: its slug, as a subdomain. */
export function appWebUrl(slug: string): string {
  return `https://${slug}.${hostedChatBaseDomain()}`
}

/** The URL to register as the Slack app's redirect URL for "Add to Slack". */
export function slackInstallRedirectUrl(apiBase: string, gatewayId: string): string {
  return `${apiBase.replace(/\/+$/, '')}/gateways/${gatewayId}/install/slack/callback`
}

/** One app an agent is part of, and the places in it where that agent answers. */
export interface AgentUsage {
  slug: string
  name: string
  places: Array<{ target: DistributionTarget; status: DistributionStatus }>
}

/** The app a gateway was published from, and which of its places it is. */
export interface GatewayManagedBy {
  app: { id: string; slug: string; name: string }
  target: DistributionTarget
}

export const appPlacesApi = {
  /** Every app the agent is part of, with where it answers in each. */
  usedBy: (agentId: string) =>
    apiGet(`/apps/used-by/${agentId}`).then((r) => unwrap<AgentUsage[]>(r) ?? []),

  /** The app that manages a gateway, or null for one no app owns. */
  appForGateway: (gatewayId: string) =>
    apiGet(`/gateways/${gatewayId}/app`).then((r: any) => (r?.data !== undefined ? r.data : r) as GatewayManagedBy | null),
}
