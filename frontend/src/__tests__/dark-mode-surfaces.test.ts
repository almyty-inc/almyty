import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Dark surfaces layer from the page up: page = --background (zinc-950),
 * cards = --card (zinc-900), recessed = --muted (zinc-800), see
 * docs/brand/colors.md.
 *
 * The app shell once painted the page with bg-muted in both themes. That is
 * right in light mode (zinc-100 page, white cards) and inverted in dark: a
 * zinc-800 page with darker cards sitting "below" it, and every outline
 * button and input, filled with --background, showing as a black hole.
 * These read the sources so the inversion cannot come back unnoticed.
 */
const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Every string literal ("...", '...', `...`) in a source file. */
const literals = (src: string) => [...src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')

const classes = (s: string) => s.split(/\s+/).filter(Boolean)

const SHELLS = ['components/layout/dashboard-layout.tsx', 'components/layout/auth-layout.tsx']

/** A full-screen root that paints a page colour other than the background token must hand dark mode back to it. */
function shellProblems(src: string): string[] {
  const problems: string[] = []
  for (const lit of literals(src)) {
    const cls = classes(lit)
    if (!cls.some((c) => /^(min-)?h-screen$/.test(c))) continue
    const light = cls.filter((c) => /^bg-/.test(c))
    const dark = cls.filter((c) => /^dark:bg-/.test(c))
    for (const d of dark) if (d !== 'dark:bg-background') problems.push(`${d} in "${lit}"`)
    if (light.some((c) => c !== 'bg-background') && !dark.includes('dark:bg-background')) {
      problems.push(`page background ${light.join(' ')} has no dark:bg-background in "${lit}"`)
    }
  }
  return problems
}

/** bg-black / bg-white (opaque) in a class string with no dark: background beside it. Overlays like bg-black/50 are fine. */
function opaqueBlackWhite(src: string): string[] {
  const out: string[] = []
  for (const lit of literals(src)) {
    const cls = classes(lit)
    const hits = cls.filter((c) => /^(hover:|focus:|group-hover:)?bg-(black|white)$/.test(c))
    if (!hits.length) continue
    // A dark: background in the same string is the pair.
    if (cls.some((c) => /^dark:(\S+:)?bg-/.test(c))) continue
    out.push(`${hits.join(' ')} in "${lit}"`)
  }
  return out
}

function filesBelow(dir: string): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) return e.name === '__tests__' ? [] : filesBelow(rel)
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [rel] : []
  })
}

describe('dark page background is the background token', () => {
  it('the detectors catch what they should and allow overlays', () => {
    expect(shellProblems('<div className="h-screen flex bg-muted">')).toHaveLength(1)
    expect(shellProblems('<div className="h-screen flex bg-muted dark:bg-card">')).toHaveLength(2)
    expect(shellProblems('<div className="h-screen flex bg-muted dark:bg-background">')).toEqual([])
    expect(shellProblems('<div className="min-h-screen bg-background">')).toEqual([])
    expect(opaqueBlackWhite('<div className="fixed inset-0 bg-black/50">')).toEqual([])
    expect(opaqueBlackWhite('<div className="rounded bg-white p-2">')).toHaveLength(1)
    expect(opaqueBlackWhite('<div className="rounded bg-white dark:bg-zinc-900">')).toEqual([])
  })

  it.each(SHELLS)('%s paints the dark page with --background', (file) => {
    const src = read(file)
    expect(src).toMatch(/(min-)?h-screen/)
    expect(shellProblems(src)).toEqual([])
  })

  it('the dashboard shell sets the page colour on its root', () => {
    // Guard against the root losing its background altogether (a transparent
    // root shows body, which is right, but the light-mode zinc-100 page goes).
    expect(read('components/layout/dashboard-layout.tsx')).toMatch(/"h-screen flex overflow-hidden bg-muted dark:bg-background"/)
  })

  it('the dark tokens keep page < card < muted in lightness', () => {
    const css = read('index.css')
    const dark = css.match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? ''
    const l = (name: string) => Number(dark.match(new RegExp(`--${name}:\\s*[\\d.]+\\s+[\\d.]+%\\s+([\\d.]+)%`))?.[1])
    expect(l('background')).toBeLessThan(l('card'))
    expect(l('card')).toBeLessThan(l('muted'))
  })
})

describe('no opaque black or white without a dark pair in ui and layout', () => {
  const files = [...filesBelow('components/ui'), ...filesBelow('components/layout')]
  it('finds the files', () => expect(files.length).toBeGreaterThan(20))
  it.each(files)('%s', (file) => {
    expect(opaqueBlackWhite(read(file))).toEqual([])
  })
})

describe('fields read on the page and on cards', () => {
  // An opaque --background fill is the deepest colour in dark mode, so a
  // field filled with it is a black slot on a card. --field is translucent.
  const FIELDS: Array<[string, RegExp]> = [
    ['components/ui/input.tsx', /border border-input bg-field /],
    ['components/ui/textarea.tsx', /border border-input bg-field /],
    ['components/ui/select.tsx', /border border-input bg-field /],
    ['components/ui/searchable-select.tsx', /border border-input bg-field /],
    ['components/ui/button.tsx', /outline:\s*\n?\s*"border border-input bg-field hover:bg-field-hover/],
  ]
  it.each(FIELDS)('%s fills with bg-field', (file, pattern) => {
    expect(read(file)).toMatch(pattern)
  })

  it('--field is defined for both themes and wired into tailwind', () => {
    const css = read('index.css')
    expect(css.match(/--field:/g)?.length).toBe(2)
    expect(css.match(/--field-hover:/g)?.length).toBe(2)
    expect(readFileSync(resolve(SRC, '../tailwind.config.js'), 'utf8')).toMatch(/field:\s*\{\s*DEFAULT:\s*"hsl\(var\(--field\)\)"/)
  })

  it('the active tab and the switch thumb lift off their track in dark mode', () => {
    expect(read('components/ui/tabs.tsx')).toContain('dark:data-[state=active]:bg-input')
    expect(read('components/ui/switch.tsx')).toMatch(/bg-background dark:bg-foreground/)
  })
})
