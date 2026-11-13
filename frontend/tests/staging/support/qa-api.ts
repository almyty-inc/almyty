/**
 * The QA user's session, for the parts of a test that are not the
 * feature under test: deleting what the test made, the daily sweep, and
 * reading a record back to assert on it. Features themselves are driven
 * through the browser.
 *
 * It rides the cookie the global setup saved; it never logs in itself
 * (login is throttled per account and per IP).
 */
import { readFileSync } from 'fs'
import { request, type APIRequestContext } from '@playwright/test'
import { API_URL, QA_ORG_FILE, QA_STATE_FILE } from './env'

export interface QaOrg {
  id: string
  name: string
}

export function qaOrg(): QaOrg {
  return JSON.parse(readFileSync(QA_ORG_FILE, 'utf-8'))
}

export async function qaApi(orgId = qaOrg().id): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_URL,
    storageState: QA_STATE_FILE,
    extraHTTPHeaders: { 'X-Organization-Id': orgId },
  })
}

/** The `data` of the API's `{ success, data }` envelope, or throws with the status. */
export async function data<T = any>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  const text = await res.text()
  if (!res.ok()) throw new Error(`${res.url()} answered ${res.status()}: ${text.slice(0, 300)}`)
  const body = text ? JSON.parse(text) : {}
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T
}

/** Kinds of things a gate test makes, and how each is deleted. */
export type Kind = 'api' | 'tool' | 'agent' | 'mcp-source' | 'credential' | 'gateway'

export function deletePath(kind: Kind, id: string, orgId: string): string {
  switch (kind) {
    case 'api': return `/apis/${id}`
    case 'tool': return `/organizations/${orgId}/tools/${id}`
    case 'agent': return `/agents/${id}`
    case 'mcp-source': return `/organizations/${orgId}/mcp-sources/${id}`
    case 'credential': return `/credentials/${id}`
    case 'gateway': return `/gateways/${id}`
  }
}

export async function deleteThing(api: APIRequestContext, kind: Kind, id: string, orgId: string): Promise<void> {
  let res
  try {
    // Deleting an API deletes its tools too, which can take a while.
    res = await api.delete(deletePath(kind, id, orgId), { timeout: 180_000 })
  } catch (err) {
    // Playwright's message carries the request headers, session cookie
    // included: keep only its first line.
    throw new Error(`delete ${kind} ${id}: ${redact(String((err as Error).message).split('\n')[0])}`)
  }
  // Gone already (an API's tools go with it) is fine.
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`delete ${kind} ${id}: ${res.status()} ${redact((await res.text()).slice(0, 200))}`)
  }
}

/** Never let a session token or an API key reach a report. */
export function redact(s: string): string {
  return s
    .replace(/(access_token=|refresh_token=|Bearer\s+|cookie:\s*|x-api-key:\s*)[^\s;,"]+/gi, '$1<redacted>')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<redacted>')
    .replace(/\b(almyty|gw|ak|sk)_[A-Za-z0-9_-]{16,}/g, '<redacted>')
}

interface Named { id: string; name: string; createdAt?: string }

/** Every page of a paged list (the API caps `limit` at 100). */
async function paged(api: APIRequestContext, url: string, rowsOf: (d: any) => any[]): Promise<any[]> {
  const out: any[] = []
  for (let page = 1; page <= 50; page++) {
    const sep = url.includes('?') ? '&' : '?'
    const rows = rowsOf(await data(await api.get(`${url}${sep}limit=100&page=${page}`))) || []
    out.push(...rows)
    if (rows.length < 100) break
  }
  return out
}

/** Everything in the QA org of one kind, as `{ id, name, createdAt }`. */
export async function list(api: APIRequestContext, kind: Kind, orgId: string): Promise<Named[]> {
  const pick = (rows: any[]): Named[] => (rows || []).map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt }))
  const arr = (d: any) => (Array.isArray(d) ? d : [])
  switch (kind) {
    case 'api': return pick(await paged(api, '/apis', (d) => d?.apis))
    case 'tool': return pick(await paged(api, `/organizations/${orgId}/tools?search=gate`, (d) => d?.tools))
    case 'agent': return pick(await paged(api, '/agents', arr))
    case 'mcp-source': return pick(await data(await api.get(`/organizations/${orgId}/mcp-sources`)))
    case 'credential': return pick(await data(await api.get('/credentials')))
    case 'gateway': return pick(await paged(api, '/gateways', (d) => d?.gateways))
  }
}

/** A gate-made name: `gate-…` or, where names are identifiers, `gate_…`. */
export const GATE_NAME = /^gate[-_]/i
