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
  version: number
  createdAt: string
  updatedAt?: string
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

export interface HostedWorkspace {
  id: string
  ownerUserId: string
  agentId: string | null
  environmentId: string
  status: 'active' | 'suspended' | 'released' | 'expired' | 'stranded'
  lastActiveAt: string | null
  createdAt: string
  machine: { id: string; state: HostedMachineState; lastActiveAt: string | null; lastError: string | null } | null
}

/** What the install allows. Read from the list response once the API sends it (`settings`); these are the shipped defaults until then. */
export interface HostedSettings {
  images: string[]
  idleTimeoutMinutes: { default: number; min: number; max: number }
  suspendedRetention: { keepDays: number }
}

export const HOSTED_DEFAULT_SETTINGS: HostedSettings = {
  images: ['standard', 'standard-browser'],
  idleTimeoutMinutes: { default: 15, min: 5, max: 120 },
  suspendedRetention: { keepDays: 30 },
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** The settings a list response carries, each part falling back to the defaults when absent or unusable. */
export function readHostedSettings(raw: unknown): HostedSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const images = Array.isArray(s.images)
    ? s.images.filter((i: unknown) => typeof i === 'string' && i)
    : s.images && typeof s.images === 'object'
      ? Object.keys(s.images)
      : []
  const idle = s.idleTimeoutMinutes ?? {}
  const idleOk = positive(idle.min) && positive(idle.max) && positive(idle.default) && idle.min <= idle.default && idle.default <= idle.max
  return {
    images: images.length ? images : HOSTED_DEFAULT_SETTINGS.images,
    idleTimeoutMinutes: idleOk ? { default: idle.default, min: idle.min, max: idle.max } : HOSTED_DEFAULT_SETTINGS.idleTimeoutMinutes,
    suspendedRetention: positive(s.suspendedRetention?.keepDays) ? { keepDays: s.suspendedRetention.keepDays } : HOSTED_DEFAULT_SETTINGS.suspendedRetention,
  }
}

const IMAGE_LABELS: Record<string, string> = {
  standard: 'Standard',
  'standard-browser': 'Standard with a web browser',
}

export function imageLabel(name: string): string {
  return IMAGE_LABELS[name] ?? name
}

/** The four states people see, plus a workspace that was let go. */
export type MachineStatus = 'running' | 'parked' | 'waking' | 'failed' | 'released'

export function machineStatus(w: Pick<HostedWorkspace, 'status' | 'machine'>): MachineStatus {
  if (w.status === 'released' || w.status === 'expired') return 'released'
  switch (w.machine?.state) {
    case 'ready':
      return 'running'
    case 'pending':
    case 'provisioning':
      return 'waking'
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
  failed: 'failed',
  released: 'released',
}

export const MACHINE_STATUS_VARIANT: Record<MachineStatus, BadgeVariant> = {
  running: 'success',
  parked: 'secondary',
  waking: 'warning',
  failed: 'destructive',
  released: 'outline',
}

/** Whether the workspace is still held (its files exist). */
export function isLiveWorkspace(w: Pick<HostedWorkspace, 'status'>): boolean {
  return w.status === 'active' || w.status === 'suspended'
}

/** When a parked workspace's files are deleted if nobody uses it: last use plus the retention window. */
export function filesKeptUntil(w: Pick<HostedWorkspace, 'lastActiveAt' | 'createdAt'>, keepDays: number): Date {
  const from = new Date(w.lastActiveAt ?? w.createdAt).getTime()
  return new Date(from + keepDays * 24 * 60 * 60 * 1000)
}

/** The caller's own live workspace (not an agent's), newest first; the one the list summarises. */
export function ownWorkspace(rows: HostedWorkspace[], userId: string | undefined): HostedWorkspace | undefined {
  if (!userId) return undefined
  return rows.filter((w) => w.ownerUserId === userId && !w.agentId && isLiveWorkspace(w))[0]
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
