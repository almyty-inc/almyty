/**
 * Push wakes, as the always-on page sees them. Mirrors
 * backend/src/modules/agents/always-on/push-wakes/ (push-wake.types.ts,
 * PushWakesService.view): a service calls the agent's own address when
 * something changes, the call is verified, and the agent wakes with what
 * changed. Presets (Google Calendar, Gmail) are data from the server.
 */
import { apiDel, apiGet, apiPatch, apiPost } from '@/lib/api'
import type { ConnectionHealth } from '@/types/connections'

export type PushVerifyMethod = 'shared_token' | 'hmac' | 'oidc_jwt'
export type PushWakeHealthStatus = 'valid' | 'failed' | 'expired' | 'unknown'

export interface PushPresetField {
  key: string
  label: string
  placeholder?: string
  help?: string
  required?: boolean
  default?: string
  pattern?: string
}

export interface PushSetupStep {
  text: string
  command?: string
  consolePath?: string
}

export interface PushWakePreset {
  key: string
  name: string
  description: string
  operations: string[]
  apiHint?: string
  fields: PushPresetField[]
  setup: PushSetupStep[]
  spec: Record<string, unknown> & { verification: { method: PushVerifyMethod } }
  debounceSeconds?: number
}

export interface PushWakeOptions {
  presets: PushWakePreset[]
  /** The organization's connections (imported APIs), and the presets each has every tool for. */
  apis: Array<{ id: string; name: string; presets: string[] }>
}

export interface PushWakeView {
  id: string
  name: string
  presetKey: string | null
  apiId: string | null
  apiName: string | null
  endpointUrl: string
  settings: Record<string, string>
  verification: PushVerifyMethod
  debounceSeconds: number
  health: { status: PushWakeHealthStatus; checkedAt: string | null; error: string | null }
  lastPushAt: string | null
  pushCount: number
  lastWakeAt: string | null
  lastRenewedAt: string | null
  subscriptionExpiresAt: string | null
  renewAt: string | null
  setup: PushSetupStep[]
  spec: Record<string, unknown>
}

export interface PushWakeInput {
  presetKey?: string | null
  apiId?: string | null
  name?: string | null
  settings?: Record<string, string>
  spec?: unknown
  debounceSeconds?: number | null
  secret?: string | null
}

export const pushWakesApi = {
  list: (agentId: string) => apiGet<PushWakeView[]>(`/agents/${agentId}/push-wakes`),
  options: (agentId: string) => apiGet<PushWakeOptions>(`/agents/${agentId}/push-wakes/options`),
  create: (agentId: string, body: PushWakeInput) => apiPost<PushWakeView>(`/agents/${agentId}/push-wakes`, body),
  update: (agentId: string, id: string, body: Pick<PushWakeInput, 'name' | 'debounceSeconds' | 'settings'>) =>
    apiPatch<PushWakeView>(`/agents/${agentId}/push-wakes/${id}`, body),
  resubscribe: (agentId: string, id: string) => apiPost<PushWakeView>(`/agents/${agentId}/push-wakes/${id}/subscribe`, {}),
  remove: (agentId: string, id: string) =>
    apiDel<{ stopped: boolean; error: string | null }>(`/agents/${agentId}/push-wakes/${id}`),
}

/** A push wake's health in the shape connections show it (ConnectionHealthBadge). */
export function pushWakeHealth(view: Pick<PushWakeView, 'health'>): ConnectionHealth {
  return { status: view.health.status, checkedAt: view.health.checkedAt, error: view.health.error }
}

export const VERIFY_LABELS: Record<PushVerifyMethod, string> = {
  shared_token: 'A value only the service knows, in a header',
  hmac: 'An HMAC signature over each push',
  oidc_jwt: 'A signed token from the service (OIDC)',
}

/** A starting point for a custom push wake: verification only; the rest is optional. */
export const CUSTOM_SPEC_TEMPLATE = JSON.stringify(
  {
    verification: { method: 'hmac', headerName: 'X-Signature', algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=', signedContent: '{{body}}' },
    summary: '{{name}}: something changed',
  },
  null,
  2,
)

/** "Last push 5 minutes ago, renewed today" -- what the row says under its name. */
export function describePushWake(view: PushWakeView, format: (iso: string) => string): string {
  const parts: string[] = []
  parts.push(view.lastPushAt ? `Last push ${format(view.lastPushAt)}` : 'No push yet')
  if (view.lastRenewedAt) parts.push(`subscribed ${format(view.lastRenewedAt)}`)
  if (view.renewAt) parts.push(`renews ${format(view.renewAt)}`)
  return parts.join(' · ')
}
