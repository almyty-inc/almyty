// Calls to the almyty API and the fakes, as walk steps make them.
import type { Env } from './env.ts'
import type { Http } from './schema.ts'

/** The rows of a list answer, whatever it is wrapped in. */
export function rows(body: unknown, key?: string): unknown[] {
  if (Array.isArray(body)) return body
  const o = (body ?? {}) as Record<string, unknown>
  for (const k of [key, 'items', 'data', 'results'].filter(Boolean) as string[]) if (Array.isArray(o[k])) return o[k] as unknown[]
  // { apis: [...], total }: the one list in it.
  const lists = Object.values(o).filter(Array.isArray)
  return lists.length === 1 ? (lists[0] as unknown[]) : []
}

/** The API answers { success, data }; steps want the data. */
export function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body && 'success' in body) return (body as { data: unknown }).data
  return body
}

export function at(body: unknown, path?: string): unknown {
  if (!path) return body
  return path.split('.').reduce<unknown>((cur, k) => (cur == null ? undefined : (cur as Record<string, unknown>)[k]), body)
}

export async function request(env: Env, call: Http, token?: string): Promise<unknown> {
  const absolute = /^https?:\/\//.test(call.url)
  const url = absolute ? call.url : `${env.api}${call.url}`
  const headers: Record<string, string> = { ...(call.headers ?? {}) }
  if ((call.auth ?? !absolute) && token) headers.authorization = `Bearer ${token}`
  let body: string | undefined
  if (call.body !== undefined) {
    body = typeof call.body === 'string' ? call.body : JSON.stringify(call.body)
    headers['content-type'] ??= 'application/json'
  }
  const res = await fetch(url, { method: call.method ?? (call.body !== undefined ? 'POST' : 'GET'), headers, body })
  const text = await res.text()
  let json: unknown
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  const ok = call.ok ? call.ok.includes(res.status) : res.ok
  if (!ok) throw new Error(`${call.method ?? 'GET'} ${url} answered ${res.status}: ${text.slice(0, 300)}`)
  return unwrap(json)
}
