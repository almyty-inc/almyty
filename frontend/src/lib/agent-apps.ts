import { apiGet, apiPost, apiPatch, apiDel } from './api'

/**
 * The agent factory client.
 *
 * An app is the product a customer ships: several agents under one
 * name, with the branding they appear under, who may use them, and what
 * a downloadable artifact may touch on the machine it runs on.
 * Distributions are that product rendered for different places.
 */

export type AppAuthMode = 'public_link' | 'email_otp' | 'oauth' | 'sso'

export type DistributionTarget = 'web' | 'channel' | 'tui' | 'desktop' | 'binary'

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
  isActive: boolean
  distributions?: AppDistribution[]
}

export interface AppCheck {
  ok: boolean
  refusals: Array<{ code: string; message: string }>
}

/**
 * What each target is, in the words an operator would use. The canvas
 * shows these rather than the enum, because "binary" alone does not
 * tell anyone what they get.
 */
export const DISTRIBUTION_LABELS: Record<DistributionTarget, string> = {
  web: 'Web app',
  channel: 'Messaging',
  tui: 'Terminal app',
  desktop: 'Desktop app',
  binary: 'Standalone binary',
}

export const DISTRIBUTION_BLURBS: Record<DistributionTarget, string> = {
  web: 'A branded chat app on its own address',
  channel: 'Slack, WhatsApp, Telegram and the rest',
  tui: 'A command your users run in a terminal',
  desktop: 'An installable windowed app',
  binary: 'One executable, no runtime to install',
}

/** Targets that produce a file someone installs, so they need signing. */
export const PACKAGED_TARGETS: DistributionTarget[] = ['desktop', 'binary']

export const AUTH_MODE_LABELS: Record<AppAuthMode, string> = {
  public_link: 'Anyone with the link',
  email_otp: 'Email verification',
  oauth: 'Sign in with OAuth',
  sso: 'Enterprise SSO',
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

  checkDistribution: (distributionId: string) =>
    apiGet(`/apps/distributions/${distributionId}/check`).then((r) => unwrap<AppCheck>(r)),

  removeDistribution: (distributionId: string) =>
    apiDel(`/apps/distributions/${distributionId}`),
}

/** True when the product grants any access to the machine it runs on. */
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
