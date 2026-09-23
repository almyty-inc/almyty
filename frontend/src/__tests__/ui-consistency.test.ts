import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

import { jsxLabels, titleCaseWords } from '@/test/jsx-labels'

/**
 * One dashboard, one design.
 *
 * The Agents and Apps empty states sat side by side and looked like two
 * products: one in a card with a circled icon, one floating bare on the
 * page with the badge invisible against the background; "Create Agent"
 * in the header and "Create agent" under it. The same drift ran through
 * every page. The fixes live in the shared pieces (PageHeader,
 * EmptyState's `variant`, sentence-case labels); these checks keep pages
 * from hand-rolling their way back out of them.
 */

const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

const isTest = (f: string) => /(__tests__|\.test\.|\.spec\.)/.test(f)
/**
 * Areas another workstream is restructuring right now (the Runner pages).
 * They are held to the same rules once that work lands; until then they
 * are listed here rather than edited twice.
 */
const OTHER_WORKSTREAMS = [
  /^pages\/runner/,
  /^pages\/runners/,
]

const inScope = (rel: string) => !OTHER_WORKSTREAMS.some((re) => re.test(rel))

const sources = walk(SRC)
  .filter((f) => !isTest(f))
  .map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }))
  .filter(({ rel }) => inScope(rel))

const pages = sources.filter(({ rel }) => rel.startsWith('pages/'))

/** Pages that are not dashboard pages: auth screens and public surfaces. */
const STANDALONE_PAGES = [
  /^pages\/auth\//,
  /^pages\/oauth\//,
  /^pages\/hosted-chat\.tsx$/,
  /^pages\/cli-login\.tsx$/,
  /^pages\/accept-invite\.tsx$/,
]
const dashboardPages = pages.filter(({ rel }) => !STANDALONE_PAGES.some((re) => re.test(rel)))

const usesSharedEmptyState = (src: string) => /from '@\/components\/ui\/empty-state'/.test(src)

describe('empty states', () => {
  it('are never wrapped in a hand-made Card (use variant="panel")', () => {
    const offenders = sources
      .filter(({ src }) => /<CardContent\b[^>]*>\s*<EmptyState\b/.test(src))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  it('choose their placement explicitly on every dashboard page', () => {
    // A page-level empty state is `panel`; one inside an existing surface
    // is `inline`. Leaving it to the default is how Apps ended up bare on
    // the page background next to Agents' card.
    const offenders: string[] = []
    for (const { rel, src } of dashboardPages) {
      if (!usesSharedEmptyState(src)) continue
      for (const el of jsxLabels(src, ['EmptyState'])) {
        if (!/\bvariant=/.test(el.attrs)) offenders.push(`${rel}:${el.line}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('are not hand-rolled out of an icon circle and an h3', () => {
    const handRolled = /<h3\b[^>]*>\s*No\s|w-16 h-16 bg-(primary|emerald-500)\/10 rounded-full/
    const offenders = sources
      .filter(({ rel }) => rel !== 'components/ui/empty-state.tsx')
      .filter(({ src }) => handRolled.test(src))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })
})

describe('page headers', () => {
  it('come from PageHeader, or use the shared detail-title style', () => {
    // A top-level page's title is rendered by <PageHeader>; a detail page's
    // <h1> takes DETAIL_TITLE_CLASSES. A literal class list is how the
    // headers drifted apart in size, weight and wrapping.
    const offenders: string[] = []
    for (const { rel, src } of dashboardPages) {
      const h1s = src.match(/<h1\b[^>]*>/g) ?? []
      for (const h1 of h1s) {
        if (!/DETAIL_TITLE_CLASSES/.test(h1)) offenders.push(`${rel}: ${h1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('labels are sentence case', () => {
  // Buttons, menu items, tabs, and the titles of dialogs and cards. Only
  // the first word is capitalised, plus acronyms and proper nouns
  // (LABEL_PROPER_NOUNS): "Create agent", "Import from JSON", "Tool Hub".
  const TAGS = [
    'Button',
    'DropdownMenuItem',
    'AlertDialogAction',
    'AlertDialogCancel',
    'TabsTrigger',
    'DialogTitle',
    'AlertDialogTitle',
    'CardTitle',
  ]

  it('holds for every label written in the source', () => {
    const offenders: string[] = []
    for (const { rel, src } of sources) {
      for (const el of jsxLabels(src, TAGS)) {
        for (const label of el.variants) {
          if (titleCaseWords(label).length) offenders.push(`${rel}:${el.line} <${el.tag}> "${label}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the brand gradient', () => {
  it('is on at most one button per page', () => {
    // docs/brand/colors.md: the violet-to-cyan gradient marks the single
    // primary CTA of a page; secondary buttons, form submits, table
    // actions and repeated elements never carry it.
    const offenders: string[] = []
    for (const { rel, src } of sources) {
      const gradientButtons = jsxLabels(src, ['Button']).filter((b) => /bg-gradient-to-/.test(b.attrs))
      if (gradientButtons.length > 1) offenders.push(`${rel}: ${gradientButtons.length}`)
    }
    expect(offenders).toEqual([])
  })
})
