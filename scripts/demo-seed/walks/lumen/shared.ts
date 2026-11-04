// What the Lumen tutorials and the personal-assistant tutorial share: the
// steps for a Google sign-in and a channel's keys, and the pieces of a page
// that are scrolled to before a screenshot.
import type { Locator, Step } from '../../engine/schema.ts'

export const MODEL_KEY = 'sk-proj-0000000000000000000000000000000000000000'
export const LINKS = {
  calendar: 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
  gmail: 'https://gmail.googleapis.com/$discovery/rest?version=v1',
  tasks: 'https://tasks.googleapis.com/$discovery/rest?version=v1',
  drive: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
  hubspot: 'https://raw.githubusercontent.com/HubSpot/HubSpot-public-api-spec-collection/main/PublicApiSpecs/CRM/',
}

// The shared UI (components/ui, components/layout, index.css) is never a source: check-screenshots rejects it as too broad.
export const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
export const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
export const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
export const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
export const APPROVALS = ['frontend/src/pages/approvals.tsx', 'frontend/src/lib/email-preview.ts']

export const button = (name: string | RegExp, exact = false): Locator => ({ role: 'button', name, exact })
export const textbox = (name: string | RegExp, nth?: 'last'): Locator => ({ role: 'textbox', name, ...(nth ? { nth } : {}) })
export const combo = (name: string): Locator => ({ role: 'combobox', name })
/** Bring an element into view, the least scrolling that does it. */
export const near = (l: Locator): Step => ({ scrollTo: l, block: 'nearest' })
/** Bring an element to the top of the screen, `offset` pixels below it. */
export const top = (l: Locator, offset = 120): Step => ({ scrollTo: l, offset })

/** A Google API's sign-in, started with your own app's keys; ticks only the scopes `scopes` matches. */
export const googleApp = (clientId: string, scopes?: RegExp): Step[] => [
  { click: button('Create one here') },
  { fill: { label: 'Client ID' }, value: clientId },
  { fill: { label: 'Client secret' }, value: 'GOCSPX-local-test-secret' },
  ...(scopes ? [
    { waitFor: { testid: 'api-oauth-redirect' }, timeout: 10000 } as Step,
    { setChecks: { role: 'checkbox', within: { testid: 'api-oauth-scopes' } }, on: scopes } as Step,
    // Ticking scrolled the list of permissions; it starts at the top again.
    { action: 'scrollBoxTop', with: { within: { testid: 'api-oauth-scopes' } } } as Step,
    top({ testid: 'api-oauth-redirect' }),
  ] : []),
]

/** A real sign-in goes to Google here; the local stand-in takes a pasted token. */
export const pastedToken = (name: string, token: string, field: string | RegExp = 'Access token'): Step[] => [
  { use: 'pasteToken', with: { name, token, field } },
  { use: 'saveSignIn' },
]

/** Save a channel's new keys, then the channel if that is still to do, and publish it. */
export const publishChannel = (done: Locator): Step[] => [
  { click: { role: 'button', name: 'Save', exact: true, nth: 'first' } },
  { if: { enabled: { role: 'button', name: 'Save', exact: true, nth: 'last' } }, then: [{ click: { role: 'button', name: 'Save', exact: true, nth: 'last' } }] },
  { click: button('Publish', true) },
  { waitFor: done, timeout: 20000 },
  { scrollTop: true },
]

/** Memory on: this agent's own, the facts it learns. */
export const ownMemory: Step[] = [
  { click: { role: 'switch', name: 'Remember between conversations' } },
  { select: combo('Whose memory'), option: /This agent's own/ },
  { select: combo('What it saves'), option: /Facts it learns/ },
]

export const pendingApprovals = { sql: `SELECT count(*) FROM approval_requests WHERE "organizationId" = '{{org.id}}' AND status = 'pending'`, not: '0' } as const

/** Approve the first request waiting in Approvals. */
export const approveOne: Step[] = [
  { click: { role: 'button', name: 'Approve', exact: true } },
  { click: { role: 'button', name: 'Approve', within: { role: 'form', name: 'Approve this action' } } },
  { waitFor: { role: 'form', name: 'Approve this action' }, state: 'hidden' },
]

/** Wait until the stand-in has received something: { at, where } over its /_admin/state. */
export const received = (at: string, where: Record<string, string | RegExp | { contains: string }>, what: string, extra: { min?: number; save?: string; timeout?: number } = {}): Step => ({
  until: { http: { url: '{{stack.upstream}}/_admin/state' }, at, where, ...(extra.min ? { min: extra.min } : {}) },
  timeout: extra.timeout ?? 180000, every: 3000, what, ...(extra.save ? { save: extra.save } : {}),
})

export const upstream = (path: string, body?: unknown): Step => ({ http: { method: 'POST', url: `{{stack.upstream}}${path}`, ...(body !== undefined ? { body } : {}) } })
