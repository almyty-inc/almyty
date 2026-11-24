/**
 * Money and time read one way everywhere (lib/format.ts): "$2.47", "<$0.01",
 * "1m 18s". Four decimals of a dollar looked like a bug and "1.3m" read as
 * a million. This fails if either comes back in a component or page.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

// Read once: every check below scans the same lines.
const lines = [...sources(join(SRC, 'components')), ...sources(join(SRC, 'pages'))].flatMap((path) => {
  const rel = relative(SRC, path)
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((text, i) => ({ rel, at: `${rel}:${i + 1}: ${text.trim()}`, text }))
})

// Per-million-token list prices, not spend: "$0.075 in / $0.30 out".
const PRICE_FILES = new Set(['components/models/model-row.tsx'])

function offending(pattern: RegExp, skip: Set<string> = new Set()): string[] {
  return lines.filter((l) => !skip.has(l.rel) && pattern.test(l.text)).map((l) => l.at)
}

describe('cost and duration formatting', () => {
  it('no component shows a cost with three or four decimals', () => {
    expect(offending(/toFixed\([34]\)/, PRICE_FILES)).toEqual([])
  })

  it('no component shows a decimal minute or hour', () => {
    expect(offending(/\/\s*(60_?000|3_?600_?000)\)\.toFixed\(/)).toEqual([])
    expect(offending(/toFixed\(\d\)\}(m|h|min)\b/)).toEqual([])
  })

  it('no component builds its own seconds or milliseconds string', () => {
    expect(offending(/\/\s*1_?000\)\.toFixed\(\d\)\}s\b/)).toEqual([])
    // "Ran in {ms}ms", "`${durationMs} ms`": a duration in raw milliseconds (a CSS delay is not one).
    expect(offending(/\}\s?ms\b/).filter((hit) => !/animation|transition|style=/.test(hit))).toEqual([])
  })

  it('the shared helpers are the formatter, not copies of it', () => {
    const constants = readFileSync(join(SRC, 'components/agents/detail/constants.ts'), 'utf8')
    expect(constants).not.toMatch(/function formatDuration/)
    expect(readFileSync(join(SRC, 'types/budgets.ts'), 'utf8')).toMatch(/formatCostCents\(/)
    expect(readFileSync(join(SRC, 'components/analytics/format.ts'), 'utf8')).toMatch(/formatDuration as formatMs/)
  })
})
