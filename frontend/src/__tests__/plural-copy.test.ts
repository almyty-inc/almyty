import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

import { pluralize, pluralized } from '@/lib/utils'

/**
 * "1 members" on a team card. A count written straight next to a plural
 * noun is wrong every time the count is one, so every "{n} things" in the
 * UI goes through pluralized() in lib/utils. These checks read the source
 * for the ways a count gets glued to a noun by hand.
 */

const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const isTest = (f: string) => /(__tests__|\.test\.|\.spec\.|\/test\/)/.test(f)
const sources = walk(SRC)
  .filter((f) => !isTest(f))
  .map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }))

/** Nouns the UI counts. A count in front of one of these is a plural site. */
const COUNTED = [
  'agent', 'API', 'app', 'attempt', 'build', 'byte', 'call', 'candidate', 'channel', 'check', 'connection',
  'credential', 'day', 'deployment', 'entry', 'entries', 'error', 'event', 'execution', 'fact', 'field', 'file',
  'gateway', 'grant', 'hour', 'install', 'invite', 'item', 'iteration', 'key', 'member', 'memory', 'memories',
  'message', 'minute', 'model', 'month', 'node', 'note', 'operation', 'origin', 'param', 'parameter', 'period',
  'policy', 'policies', 'provider', 'request', 'result', 'retry', 'retries', 'revision', 'role', 'row', 'rule',
  'run', 'schema', 'second', 'secret', 'site', 'skill', 'source', 'step', 'team', 'thing', 'token', 'tool',
  'user', 'version', 'warning', 'week', 'workflow',
]
const PLURALS = COUNTED.map((w) => (w.endsWith('ies') ? w : w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's'))
const NOUN = `(?:${[...new Set(PLURALS)].join('|')})`

/**
 * Sites that look like a count and a noun but are not one, each with why.
 * Keyed by file and the exact text matched.
 */
const ALLOWED: Array<{ rel: string; text: string; why: string }> = [
  { rel: 'components/agent-apps/signing-credential-form.tsx', text: '{DISTRIBUTION_LABELS[target]} builds', why: 'a target name ("Desktop builds"), not a count' },
  { rel: 'components/connections/connection-detail.tsx', text: "use${usedBy.length === 1 ? 's' : ''}", why: 'the verb agreeing with a pluralized() count, not a noun' },
]

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/** The offending sites for each hand-rolled pattern, as "file:line text". */
export function handRolledPlurals(files: Array<{ rel: string; src: string }>): string[] {
  const patterns = [
    // {n} tools  /  ${n} tools  (the expression holds no nested braces)
    // (not a JSX prop: `models={models} tools={tools}`)
    new RegExp(`\\{[^{}\\n]*\\}[ \\t]+${NOUN}\\b(?!=)`, 'g'),
    // tool{n !== 1 ? 's' : ''}  /  tool${n === 1 ? '' : 's'}
    // and ${purpose}${n === 1 ? '' : 's'}
    /(?:\b[A-Za-z]+|\})\$?\{[^{}\n]*[!=]==?\s*1\s*\?\s*'(?:s|es)?'\s*:\s*'(?:s|es)?'\s*\}/g,
    // n === 1 ? 'period' : 'periods'  /  n !== 1 ? 'periods' : 'period'
    /[!=]==?\s*1\s*\?\s*'([a-z ]+)'\s*:\s*'\1e?s'/g,
    /!==?\s*1\s*\?\s*'([a-z ]+)e?s'\s*:\s*'\1'/g,
    // note(s) in copy; set.has(s), add(s) and http(s) are not copy
    /(?<![.\w])[a-z]+\(s\)(?![)};,])/g,
  ]
  const out: string[] = []
  for (const { rel, src } of files) {
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const before = src.slice(Math.max(0, src.lastIndexOf('\n', m.index!)), m.index)
        if (/^\s*(\/\/|\*|\/\*)/.test(before.replace(/^\n/, ''))) continue // comments
        if (/^https?\(s\)$/.test(m[0]) || /^(has|add|delete|includes)\(s\)$/.test(m[0])) continue
        if (ALLOWED.some((a) => a.rel === rel && m[0].includes(a.text))) continue
        out.push(`${rel}:${lineOf(src, m.index!)} ${m[0]}`)
      }
    }
  }
  return out
}

describe('pluralized', () => {
  it('says one thing for one and things for the rest', () => {
    expect(pluralized(1, 'member')).toBe('1 member')
    expect(pluralized(0, 'member')).toBe('0 members')
    expect(pluralized(2, 'member')).toBe('2 members')
    expect(pluralized(undefined, 'tool')).toBe('0 tools')
  })

  it('knows the plurals that are not a bare s', () => {
    expect(pluralize(2, 'policy')).toBe('policies')
    expect(pluralize(2, 'entry')).toBe('entries')
    expect(pluralize(2, 'day')).toBe('days')
    expect(pluralize(2, 'status')).toBe('statuses')
    expect(pluralize(2, 'person')).toBe('people')
    expect(pluralize(2, 'API')).toBe('APIs')
    expect(pluralize(2, 'short-term note')).toBe('short-term notes')
    expect(pluralize(2, 'ms')).toBe('ms')
    expect(pluralize(2, 'datum', 'data')).toBe('data')
  })
})

describe('counts in the UI', () => {
  it('go through pluralized(), never a count glued to a plural noun', () => {
    expect(handRolledPlurals(sources)).toEqual([])
  })

  it('the check catches each hand-rolled form', () => {
    const fake = [
      { rel: 'a.tsx', src: '<Badge>{team.members?.length || 0} members</Badge>' },
      { rel: 'b.ts', src: 'const s = `${ready} of ${total} tools ready`' },
      { rel: 'c.tsx', src: "<span>{n} tool{n !== 1 ? 's' : ''}</span>" },
      { rel: 'd.ts', src: "const s = `${n} policy${n === 1 ? '' : 's'}`" },
      { rel: 'e.ts', src: 'const s = `${n} note(s) folded in`' },
      { rel: 'e2.ts', src: "const s = `${n} more ${purpose}${n === 1 ? '' : 's'}`" },
      { rel: 'e3.tsx', src: "<span>{n} {n === 1 ? 'period' : 'periods'}</span>" },
      { rel: 'f.tsx', src: "<span>{pluralized(n, 'member')}</span>" },
      { rel: 'g.ts', src: '// {n} members in a comment' },
    ]
    const found = handRolledPlurals(fake).map((f) => f.split(':')[0])
    expect(found).toEqual(['a.tsx', 'b.ts', 'c.tsx', 'd.ts', 'e.ts', 'e2.ts', 'e3.tsx'])
  })

  it('keeps the allowlist honest: every entry still matches something', () => {
    for (const a of ALLOWED) {
      const file = sources.find((s) => s.rel === a.rel)
      expect(file?.src.includes(a.text), `${a.rel}: ${a.text}`).toBe(true)
    }
  })
})
