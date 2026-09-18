import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The backend wraps every error as { error: { code, message, statusCode } }.
// A call site that reaches straight through an axios rejection for
// `response.data.message` therefore reads `undefined` for every real backend
// error and shows its generic fallback instead — the actual reason never
// reaches the user. `getApiErrorMessage` tries the wrapped shape first, so
// every such call site must go through it.
//
// This deliberately only matches the full `response…data…message` chain.
// Destructuring the body first and reading several fields off it (the
// structured extractors in connections-api/deployments-api, which need the
// code and the payload too, not just a string) is a different job and is
// left alone; so is any `data.message` that is a response payload rather
// than an error.
const SRC = join(__dirname, '..', '..')
const ALLOWED = new Set(['lib/api-error.ts', 'lib/__tests__/api-error-is-the-only-reader.test.ts', 'lib/__tests__/api-error.test.ts'])
const BROKEN_READ = /response\s*\??\.\s*data\s*\??\.\s*message\b/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('api error messages go through the shared helper', () => {
  // Walking every .ts/.tsx under src costs more than the 5s default.
  it('no source file reads response.data.message directly', { timeout: 60_000 }, () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(/[\\/]/).join('/')
      if (ALLOWED.has(rel)) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        if (BROKEN_READ.test(line)) offenders.push(`${rel}:${i + 1}: ${trimmed}`)
      })
    }
    expect(offenders, `use getApiErrorMessage(err, fallback) instead:\n${offenders.join('\n')}`).toEqual([])
  })
})
