import { apiGet, apiPost, apiPatch, apiDel, getApiBaseUrl } from './api'

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

export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

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
 * The credentials each channel needs before it can carry a message.
 *
 * Mirrors REQUIRED_CREDENTIALS in the backend
 * (distribution-publish.ts). Kept in step by hand rather than fetched,
 * because it is a small fixed table and the alternative is a round trip
 * to render a form. The backend is the authority: it refuses to publish
 * a distribution missing any of these, so a drift here only ever means
 * an extra or missing field, never a surface that ships unprotected.
 */
export const CHANNEL_CREDENTIAL_FIELDS: Partial<Record<DistributionTarget, Array<{ key: string; label: string; secret?: boolean }>>> = {
  slack: [
    { key: 'bot_token', label: 'Bot token', secret: true },
    { key: 'signing_secret', label: 'Signing secret', secret: true },
  ],
  discord: [{ key: 'bot_token', label: 'Bot token', secret: true }],
  telegram: [{ key: 'bot_token', label: 'Bot token', secret: true }],
  whatsapp: [
    { key: 'twilio_account_sid', label: 'Twilio account SID' },
    { key: 'twilio_auth_token', label: 'Twilio auth token', secret: true },
    { key: 'phone_number', label: 'Phone number' },
  ],
  whatsapp_cloud: [
    { key: 'access_token', label: 'Access token', secret: true },
    { key: 'phone_number_id', label: 'Phone number ID' },
    { key: 'app_secret', label: 'App secret', secret: true },
    { key: 'verify_token', label: 'Verify token', secret: true },
  ],
  sms: [
    { key: 'twilio_account_sid', label: 'Twilio account SID' },
    { key: 'twilio_auth_token', label: 'Twilio auth token', secret: true },
    { key: 'phone_number', label: 'Phone number' },
  ],
  email: [
    { key: 'resend_api_key', label: 'Resend API key', secret: true },
    { key: 'inbound_address', label: 'Inbound address' },
    { key: 'reply_from', label: 'Reply-from address' },
  ],
  webhook: [
    { key: 'callback_url', label: 'Callback URL' },
    { key: 'secret', label: 'Shared secret', secret: true },
  ],
  google_chat: [
    { key: 'webhook_url', label: 'Webhook URL' },
    { key: 'verification_token', label: 'Verification token', secret: true },
  ],
  microsoft_teams: [
    { key: 'bot_id', label: 'Bot ID' },
    { key: 'bot_password', label: 'Bot password', secret: true },
    { key: 'service_url', label: 'Service URL' },
  ],
  signal: [
    { key: 'api_url', label: 'Bridge API URL' },
    { key: 'phone_number', label: 'Phone number' },
  ],
  matrix: [
    { key: 'homeserver_url', label: 'Homeserver URL' },
    { key: 'access_token', label: 'Access token', secret: true },
    { key: 'room_id', label: 'Room ID' },
  ],
  irc: [
    { key: 'webhook_url', label: 'Bridge webhook URL' },
    { key: 'bridge_token', label: 'Bridge token', secret: true },
    { key: 'nick', label: 'Nick' },
    { key: 'channel', label: 'Channel' },
  ],
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
