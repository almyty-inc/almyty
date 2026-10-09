/**
 * Shared types, wording and helpers for hosted environments: the Hosted
 * tab on /runners, the new-environment page and an environment's page.
 *
 * A hosted environment describes a machine almyty starts for you
 * (backend hosted-runners/, docs/hosted-runners.md). Each person who uses
 * it gets their own workspace on it, whose machine runs while it is used,
 * parks itself after the idle timeout and keeps its files while parked.
 */
import type { BadgeProps } from '@/components/ui/badge'

type BadgeVariant = NonNullable<BadgeProps['variant']>

export type EnvironmentVisibility = 'private' | 'team' | 'org'

export interface HostedEnvironment {
  id: string
  name: string
  description: string | null
  ownerUserId: string
  visibility: EnvironmentVisibility
  teamId: string | null
  repo: { url: string; ref?: string | null; connectionId?: string | null } | null
  image: { base: string; ref?: string }
  setupScript: string | null
  egress: { allowHosts: string[]; allowBinaries?: string[] }
  resourceClass: string
  idleTimeoutMinutes: number
  /** Let a model provider's own key into the machines, for a coding tool that cannot go through almyty. */
  allowVendorKeys?: boolean
  version: number
  createdAt: string
  updatedAt?: string
  /** The caller's own machine here; null when they have none yet. */
  mine?: MyMachine | null
}

export type HostedMachineState =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'suspending'
  | 'suspended'
  | 'failed'
  | 'tearing_down'
  | 'torn_down'
  | 'orphaned'

export interface HostedMachine {
  id: string
  state: HostedMachineState
  /** 1 when something asked for the pod; a fresh machine is pending with 0. */
  desired?: { replicas: number } | null
  lastActiveAt?: string | null
  lastError: string | null
}

export interface HostedWorkspace {
  id: string
  ownerUserId: string
  agentId: string | null
  environmentId: string
  status: 'active' | 'suspended' | 'released' | 'expired' | 'stranded'
  lastActiveAt: string | null
  createdAt: string
  /** Kept from a member who left, beside the receiver's own: to copy from or delete, never to work in by default. */
  readOnly?: boolean
  inheritedFromUserId?: string | null
  machine: HostedMachine | null
}

/** The caller's own machine on an environment, as the list carries it (`mine`). */
export interface MyMachine {
  workspaceId: string
  status: string
  lastActiveAt: string | null
  machine: HostedMachine | null
}

/** What the install allows, from the `settings` of GET /environments (also GET /environments/settings). */
export interface HostedSettings {
  images: string[]
  idleTimeoutMinutes: { default: number; min: number; max: number }
  suspendedRetention: { keepDays: number }
}
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/**
 * The install's settings as the API sends them, or null when it sent none
 * that hold together. Nothing here invents a default: the form waits for
 * the server's choices.
 */
export function readHostedSettings(raw: unknown): HostedSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, any>
  const images = Array.isArray(s.images)
    ? s.images.filter((i: unknown) => typeof i === 'string' && i)
    : s.images && typeof s.images === 'object'
      ? Object.keys(s.images)
      : []
  const idle = s.idleTimeoutMinutes ?? {}
  const idleOk = positive(idle.min) && positive(idle.max) && positive(idle.default) && idle.min <= idle.default && idle.default <= idle.max
  const keepDays = s.suspendedRetention?.keepDays
  if (!images.length || !idleOk || !positive(keepDays)) return null
  return {
    images,
    idleTimeoutMinutes: { default: idle.default, min: idle.min, max: idle.max },
    suspendedRetention: { keepDays },
  }
}

const IMAGE_LABELS: Record<string, string> = {
  standard: 'Standard',
  'standard-browser': 'Standard with a web browser',
}

export function imageLabel(name: string): string {
  return IMAGE_LABELS[name] ?? name
}

/** The four states people see, a machine nothing has asked for yet, and a workspace that was let go. */
export type MachineStatus = 'running' | 'parked' | 'waking' | 'idle' | 'failed' | 'released'

export function machineStatus(w: { status: string; machine: { state: string; desired?: { replicas: number } | null } | null }): MachineStatus {
  if (w.status === 'released' || w.status === 'expired') return 'released'
  switch (w.machine?.state) {
    case 'ready':
      return 'running'
    case 'pending':
    case 'provisioning':
      // Starting only when something asked for the machine (desired.replicas 1).
      return w.machine.desired && w.machine.desired.replicas === 0 ? 'idle' : 'waking'
    case 'failed':
      return 'failed'
    case 'tearing_down':
    case 'torn_down':
    case 'orphaned':
      return 'released'
    default:
      return 'parked'
  }
}

export const MACHINE_STATUS_LABEL: Record<MachineStatus, string> = {
  running: 'running',
  parked: 'parked',
  waking: 'waking',
  idle: 'not started',
  failed: 'failed',
  released: 'released',
}

export const MACHINE_STATUS_VARIANT: Record<MachineStatus, BadgeVariant> = {
  running: 'success',
  parked: 'secondary',
  waking: 'warning',
  idle: 'outline',
  failed: 'destructive',
  released: 'outline',
}

/** Whether the workspace is still held (its files exist). */
export function isLiveWorkspace(w: Pick<HostedWorkspace, 'status'>): boolean {
  return w.status === 'active' || w.status === 'suspended'
}

/** When a parked workspace's files are deleted if nobody uses it: last use plus the retention window. */
export function filesKeptUntil(w: { lastActiveAt: string | null; createdAt?: string }, keepDays: number, now = new Date()): Date {
  const from = w.lastActiveAt ?? w.createdAt
  return new Date((from ? new Date(from).getTime() : now.getTime()) + keepDays * 24 * 60 * 60 * 1000)
}

/** Lowercase letters, digits and dashes, starting with a letter: the name becomes part of its tools' names. */
export const ENVIRONMENT_NAME_PATTERN = '[a-z][a-z0-9\\-]{0,63}'
export const ENVIRONMENT_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/

/** One site per line (commas and spaces also separate), lower case, no repeats. */
export function parseAllowedSites(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))]
}

/** A plain host name: no scheme, path, port, wildcard or address. The server checks again. */
export function isPlainHost(host: string): boolean {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return false
  return !/^[0-9.]+$/.test(host)
}

export const SHARED_ENVIRONMENTS_ENTITLEMENT = 'hosted_shared_environments'

/** GET /environments/usage: runner minutes in a period (this month by default). */
export interface EnvironmentUsage {
  from: string
  to: string
  environments: Array<{ environmentId: string; name: string; minutes: number; byClass: Record<string, number> }>
  /** The whole organization; only owners and admins get it, null for everyone else. */
  organization: { minutes: number; byClass: Record<string, number> } | null
}

/** GET /environments/:id/runs: runs of agents whose machine is this environment. */
export interface EnvironmentRun {
  id: string
  kind: 'run' | 'execution'
  agentId: string
  agentName: string
  status: string
  userId: string | null
  createdAt: string
  updatedAt: string
}

/** Machine time in plain words: "0 min", "42 min", "3 h 5 min". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} min`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m ? `${h} h ${m} min` : `${h} h`
}
