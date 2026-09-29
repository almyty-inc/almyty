import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

import { toListPage } from '../list-queries'

/**
 * One React Query key, one queryFn, one shape.
 *
 * React Query caches by key alone. When two components define a query
 * under the same key but fetch or normalize differently, whichever runs
 * first owns the cache and the other reads a shape it did not ask for.
 * That blanked /models (['llm-providers']), and the Gateways page showed
 * "No gateways yet" after the analytics tab had cached a bare array under
 * ['gateways', orgId] where the page expected the `{ gateways }` envelope;
 * ['tools', orgId] had the same split between the dashboard and the node
 * config panel. Shared keys now go through lib/list-queries.ts.
 *
 * This reads every inline `useQuery({ queryKey, queryFn })`, groups them
 * by key (variables collapsed, string literals kept) and fails when one
 * key is fetched two different ways. Variable names, non-null assertions
 * and type casts do not count as a difference; a different call or a
 * different normalization does.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

/** If a string or comment starts at `i`, the index just past it; else `i`. */
function skipLiteral(src: string, i: number): number {
  const c = src[i]
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
    return j + 1
  }
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i)
    return nl === -1 ? src.length : nl
  }
  if (c === '/' && src[i + 1] === '*') return src.indexOf('*/', i + 2) + 2
  return i
}

/** Index just past the bracket that closes the one at `open`. */
function closeOf(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const next = skipLiteral(src, i)
    if (next !== i) {
      i = next
      continue
    }
    const c = src[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c) && --depth === 0) return i + 1
    i++
  }
  return src.length
}

/** Top-level `name: value` pairs of an object literal's text. */
function properties(obj: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = obj.slice(1, -1)
  const push = (part: string) => {
    const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/)
    if (m) out[m[1]] = m[2]
  }
  let start = 0
  let i = 0
  while (i < body.length) {
    const next = skipLiteral(body, i)
    if (next !== i) {
      i = next
    } else if ('([{'.includes(body[i])) {
      i = closeOf(body, i)
    } else {
      if (body[i] === ',') {
        push(body.slice(start, i))
        start = i + 1
      }
      i++
    }
  }
  push(body.slice(start))
  return out
}

/** Applies `edit` to the code between string literals, leaving the literals alone. */
function outsideStrings(src: string, edit: (code: string) => string): string {
  return src
    .split(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/)
    .map((part, i) => (i % 2 ? part : edit(part)))
    .join('')
}

function normalizeKey(key: string): string | null {
  const k = key.replace(/\s+/g, ' ').trim()
  // A bare local variable (`key`) means something different in every file.
  if (/^[a-z_$][\w$]*$/.test(k)) return null
  if (!k.startsWith('[')) return k
  return outsideStrings(k, (code) =>
    code.replace(/(\.\.\.)?[A-Za-z_$][\w$]*(\??!?\.[A-Za-z_$][\w$]*|!)*(\(\))?/g, (m, spread) => (spread ? m : '_')),
  )
}

const KEPT = /^(async|await|return|const|let|if|else|throw|new|typeof|null|undefined|true|false)$/

function fingerprint(fn: string): string {
  const code = fn.replace(/\/\/[^\n]*/g, '').replace(/\s+as\s+[A-Za-z_$][\w$.]*(<[^>]*>)?(\[\])*/g, '')
  return outsideStrings(code, (part) =>
    part
      .replace(/!(?=[.)\],;\s])/g, '')
      .replace(/[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*/g, (chain) =>
        /Api\./.test(chain) || /^(Array|Object|JSON|Promise)\./.test(chain) || KEPT.test(chain) ? chain : '_',
      ),
  )
    .replace(/\s+/g, '')
    .replace(/[,;]+$/, '')
}

const CALL = /\b(useQuery|useSuspenseQuery|useInfiniteQuery|fetchQuery|prefetchQuery|ensureQueryData)\(\s*\{/g

function inlineQueries(root: string) {
  const found: { where: string; key: string; fn: string }[] = []
  for (const file of sources(root)) {
    const src = readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    CALL.lastIndex = 0
    while ((m = CALL.exec(src))) {
      const open = src.indexOf('{', m.index)
      const props = properties(src.slice(open, closeOf(src, open)))
      if (!props.queryKey || !props.queryFn) continue
      const key = normalizeKey(props.queryKey)
      if (!key) continue
      const line = src.slice(0, m.index).split('\n').length
      found.push({ where: `${relative(root, file)}:${line}`, key, fn: fingerprint(props.queryFn) })
    }
  }
  return found
}

describe('one shape per query key', () => {
  // Read once: walking and scanning the whole tree is the slow part.
  const queries = inlineQueries(join(__dirname, '..', '..'))
  it('no key is fetched two different ways', () => {
    const byKey = new Map<string, { where: string; fn: string }[]>()
    for (const q of queries) {
      byKey.set(q.key, [...(byKey.get(q.key) ?? []), q])
    }
    const conflicts = [...byKey.entries()]
      .filter(([, qs]) => new Set(qs.map((q) => q.fn)).size > 1)
      .map(([key, qs]) => `${key}: ${qs.map((q) => q.where).join(', ')}`)
    expect(conflicts).toEqual([])
  })

  it('keys owned by a shared query are never defined inline', () => {
    // A page that spreads toolsQuery(orgId) and a page that writes its own
    // queryFn under ['tools', orgId] are the same split the test above
    // looks for, with one side hidden behind the spread.
    const shared = readFileSync(join(__dirname, '..', 'list-queries.ts'), 'utf8')
    const owned = new Set(
      [...shared.matchAll(/queryKey:\s*(\[[^\]]*\])/g), [0, "['llm-providers']"]].map((m) => normalizeKey(m[1] as string)),
    )
    expect(owned.size).toBeGreaterThanOrEqual(5)
    const offenders = queries
      .filter((q) => owned.has(q.key))
      .map((q) => `${q.key} at ${q.where}`)
    expect(offenders).toEqual([])
  })

  it('reads queries it is meant to catch', () => {
    // The scanner has to see the queries at all, or the guard above passes
    // on an empty list.
    expect(queries.length).toBeGreaterThan(100)
  })

  it('treats renamed variables and casts as the same fetch, and a different call as different', () => {
    expect(fingerprint('() => organizationsApi.getMembers(organizationId!)')).toBe(
      fingerprint('() => organizationsApi.getMembers(org.id)'),
    )
    expect(fingerprint('() => billingApi.getStatus(orgId!) as Promise<BillingStatus>')).toBe(
      fingerprint('() => billingApi.getStatus(organizationId!)'),
    )
    expect(fingerprint('() => gatewaysApi.getAll()')).not.toBe(
      fingerprint('async () => { const d = await gatewaysApi.getAll(); return Array.isArray(d) ? d : d?.gateways }'),
    )
    expect(normalizeKey("['tools', currentOrganization?.id]")).toBe(normalizeKey("['tools', orgId]"))
    expect(normalizeKey("['tools', orgId]")).not.toBe(normalizeKey("['agents', orgId]"))
    expect(normalizeKey('[...POLICIES_QUERY_KEY, id]')).not.toBe(normalizeKey('[...REVIEW_QUERY_KEY, id]'))
  })
})

describe('toListPage', () => {
  it('reads the envelope and keeps its total', () => {
    expect(toListPage({ tools: [{ id: 'a' }], total: 7 }, 'tools')).toEqual({ items: [{ id: 'a' }], total: 7 })
  })

  it('reads a bare array', () => {
    expect(toListPage([{ id: 'a' }, { id: 'b' }], 'agents')).toEqual({ items: [{ id: 'a' }, { id: 'b' }], total: 2 })
  })

  it('answers an empty page for anything else', () => {
    expect(toListPage(undefined, 'gateways')).toEqual({ items: [], total: 0 })
    expect(toListPage({ gateways: 'nope' }, 'gateways')).toEqual({ items: [], total: 0 })
  })
})
