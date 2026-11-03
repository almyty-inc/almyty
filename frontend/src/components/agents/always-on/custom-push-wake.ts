/**
 * The custom push wake form as data: what a person fills in for a service
 * almyty has no preset for, and the spec it saves as (mirrors
 * backend/src/modules/agents/always-on/push-wakes/push-wake.types.ts).
 * Every step is optional; only how a push is proven is required.
 */
import type { PushVerifyMethod } from '@/lib/push-wakes'

export const ARG_PARTS = ['path', 'query', 'header', 'body'] as const
export type ArgPart = (typeof ARG_PARTS)[number]

export interface ArgRow {
  part: ArgPart
  name: string
  value: string
}

export interface PairRow {
  name: string
  value: string
}

export interface StepForm {
  on: boolean
  operation: string
  args: ArgRow[]
}

export interface CustomPushForm {
  name: string
  method: PushVerifyMethod
  headerName: string
  /** shared_token: almyty makes the value (true) or the service gave one (false). */
  generated: boolean
  algorithm: 'sha1' | 'sha256' | 'sha512'
  encoding: 'hex' | 'base64'
  prefix: string
  signedContent: string
  timestampHeader: string
  issuers: string
  jwksUrl: string
  audience: string
  claims: PairRow[]
  subscribe: StepForm & { expiresAtPath: string; cursorPath: string; keep: PairRow[] }
  renew: { on: boolean; everyMinutes: string; beforeExpiryMinutes: string; stopPrevious: boolean }
  stop: StepForm
  changes: StepForm & { itemsPath: string; cursorPath: string; nextPagePath: string; resetOnStatus: string; item: PairRow[] }
  summary: string
}

const step = (): StepForm => ({ on: false, operation: '', args: [] })

export function emptyCustomForm(): CustomPushForm {
  return {
    name: '',
    method: 'hmac',
    headerName: 'X-Signature',
    generated: true,
    algorithm: 'sha256',
    encoding: 'hex',
    prefix: '',
    signedContent: '{{body}}',
    timestampHeader: '',
    issuers: '',
    jwksUrl: '',
    audience: '',
    claims: [],
    subscribe: { ...step(), expiresAtPath: '', cursorPath: '', keep: [] },
    renew: { on: false, everyMinutes: '', beforeExpiryMinutes: '', stopPrevious: false },
    stop: step(),
    changes: { ...step(), itemsPath: '', cursorPath: '', nextPagePath: '', resetOnStatus: '', item: [{ name: 'id', value: 'id' }] },
    summary: '{{name}}: something changed',
  }
}

/** Argument rows as the grouped shape every API tool takes; a body name with dots nests. */
export function argsFromRows(rows: ArgRow[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    const group = (out[row.part] ??= {})
    if (row.part !== 'body') {
      group[name] = row.value
      continue
    }
    const keys = name.split('.').filter(Boolean)
    let at = group
    keys.forEach((k, i) => {
      if (i === keys.length - 1) at[k] = row.value
      else at = at[k] = at[k] && typeof at[k] === 'object' ? at[k] : {}
    })
  }
  return out
}

function pairs(rows: PairRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((r) => r.name.trim() && r.value.trim()).map((r) => [r.name.trim(), r.value.trim()]))
}

function positive(text: string): number | null {
  if (!text.trim()) return null
  const n = Number(text)
  return Number.isInteger(n) && n > 0 ? n : NaN
}

/** The spec a filled-in form saves as, or what is missing in words. */
export function specFromCustomForm(f: CustomPushForm): { spec?: Record<string, any>; error?: string } {
  if (f.method !== 'oidc_jwt' && !f.headerName.trim()) return { error: 'Name the header the service sends its proof in.' }
  let verification: Record<string, any>
  if (f.method === 'shared_token') verification = { method: 'shared_token', headerName: f.headerName.trim(), generated: f.generated }
  else if (f.method === 'hmac') {
    if (!f.signedContent.trim()) return { error: 'Say what the service signs, for example {{body}}.' }
    verification = {
      method: 'hmac',
      headerName: f.headerName.trim(),
      algorithm: f.algorithm,
      encoding: f.encoding,
      ...(f.prefix.trim() ? { prefix: f.prefix.trim() } : {}),
      signedContent: f.signedContent.trim(),
      ...(f.timestampHeader.trim() ? { timestampHeader: f.timestampHeader.trim() } : {}),
    }
  } else {
    const issuers = f.issuers.split(/[\s,]+/).filter(Boolean)
    if (!issuers.length) return { error: 'Enter the issuer of the signed token.' }
    if (!/^https:\/\//.test(f.jwksUrl.trim())) return { error: "Enter the HTTPS address of the issuer's signing keys." }
    verification = {
      method: 'oidc_jwt',
      issuers,
      jwksUrl: f.jwksUrl.trim(),
      ...(f.audience.trim() ? { audience: f.audience.trim() } : {}),
      ...(Object.keys(pairs(f.claims)).length ? { claims: pairs(f.claims) } : {}),
    }
  }
  const spec: Record<string, any> = { verification, summary: f.summary.trim() || '{{name}}: something changed' }

  const call = (s: StepForm, what: string) => {
    if (!s.operation) throw new Error(`Choose the tool for ${what}.`)
    return { operation: s.operation, arguments: argsFromRows(s.args) }
  }
  try {
    if (f.subscribe.on) {
      spec.subscribe = {
        ...call(f.subscribe, 'subscribing'),
        ...(f.subscribe.expiresAtPath.trim() ? { expiresAtPath: f.subscribe.expiresAtPath.trim() } : {}),
        ...(f.subscribe.cursorPath.trim() ? { cursorPath: f.subscribe.cursorPath.trim() } : {}),
        ...(Object.keys(pairs(f.subscribe.keep)).length ? { keep: pairs(f.subscribe.keep) } : {}),
      }
    }
    if (f.renew.on) {
      if (!f.subscribe.on) return { error: 'Renewing subscribes again, so it needs the subscribe step.' }
      const every = positive(f.renew.everyMinutes)
      const before = positive(f.renew.beforeExpiryMinutes)
      if (Number.isNaN(every) || Number.isNaN(before)) return { error: 'Renewal times are whole numbers of minutes.' }
      if (!every && !before) return { error: 'Say when to renew: every so many minutes, or before it ends.' }
      spec.renew = { ...(every ? { everyMinutes: every } : {}), ...(before ? { beforeExpiryMinutes: before } : {}), stopPrevious: f.renew.stopPrevious }
    }
    if (f.stop.on) spec.stop = call(f.stop, 'stopping')
    if (f.changes.on) {
      if (!f.changes.itemsPath.trim() || !f.changes.cursorPath.trim()) return { error: 'Say where the answer lists the changes and where it gives the next position.' }
      if (!Object.keys(pairs(f.changes.item)).length) return { error: 'Say what the agent is told about each change.' }
      const reset = f.changes.resetOnStatus.split(/[\s,]+/).filter(Boolean).map(Number)
      if (reset.some((n) => !Number.isInteger(n))) return { error: 'Statuses that start over are numbers, like 410.' }
      spec.changes = {
        ...call(f.changes, 'reading what changed'),
        itemsPath: f.changes.itemsPath.trim(),
        cursorPath: f.changes.cursorPath.trim(),
        ...(f.changes.nextPagePath.trim() ? { nextPagePath: f.changes.nextPagePath.trim(), maxPages: 10 } : {}),
        ...(reset.length ? { resetOnStatus: reset } : {}),
        item: pairs(f.changes.item),
      }
    }
  } catch (err) {
    return { error: (err as Error).message }
  }
  return { spec }
}

/** Whether saving needs a key from the person: an HMAC key, or a shared value the service chose. */
export function customNeedsSecret(f: Pick<CustomPushForm, 'method' | 'generated'>): boolean {
  return f.method === 'hmac' || (f.method === 'shared_token' && !f.generated)
}

/** Whether a custom form calls the connection's tools (and so needs a connection). */
export function customCallsTools(f: CustomPushForm): boolean {
  return f.subscribe.on || f.stop.on || f.changes.on
}
