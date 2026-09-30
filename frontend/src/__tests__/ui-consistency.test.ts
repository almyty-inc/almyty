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
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const isTest = (f: string) => /(__tests__|\.test\.|\.spec\.)/.test(f)
const all = walk(SRC)
  .filter((f) => !isTest(f) && !f.includes('/test/'))
  .map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }))
const sources = all.filter(({ rel }) => rel.endsWith('.tsx'))
const tsSources = all.filter(({ rel }) => !rel.endsWith('.tsx'))

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

  it('holds for confirmations and empty states too', () => {
    // useConfirm() takes its title and button as plain strings, and an
    // EmptyState's title is an attribute, so neither is a JSX child the
    // check above reads. "Delete Tool" in a confirm is the same drift.
    const offenders: string[] = []
    const literal = /\b(confirmLabel|cancelLabel|title):\s*(['"])([^'"\n]*)\2/g
    for (const { rel, src } of sources) {
      if (!/\buseConfirm\s*\(/.test(src)) continue
      for (const m of src.matchAll(literal)) {
        if (titleCaseWords(m[3]).length) offenders.push(`${rel} ${m[1]}: "${m[3]}"`)
      }
    }
    for (const { rel, src } of sources) {
      for (const el of jsxLabels(src, ['EmptyState'])) {
        const title = /\btitle="([^"]*)"/.exec(el.attrs)?.[1]
        if (title && titleCaseWords(title).length) offenders.push(`${rel}:${el.line} EmptyState: "${title}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('holds for field labels, headings, table headers and select options', () => {
    // "First Name" over one field and "Model name" over the next read as
    // two products. The same rule as buttons: first word, acronyms and
    // proper nouns only.
    const FIELD_TAGS = ['Label', 'label', 'SelectItem', 'option', 'TableHead', 'th', 'h1', 'h2', 'h3', 'h4']
    const offenders: string[] = []
    for (const { rel, src } of sources) {
      for (const el of jsxLabels(src, FIELD_TAGS)) {
        for (const label of el.variants) {
          if (titleCaseWords(label).length) offenders.push(`${rel}:${el.line} <${el.tag}> "${label}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('holds for label, title and header props written as literals', () => {
    // .ts files too: label maps, guide steps and page intros are copy.
    expect(literalPropOffenders([...sources, ...tsSources])).toEqual([])
  })

  it('holds for plain text styled as a heading', () => {
    expect(styledHeadingOffenders(sources)).toEqual([])
  })

  it('holds for toast titles', () => {
    expect(toastTitleOffenders([...sources, ...tsSources])).toEqual([])
  })

  it('each check catches the pattern it is for', () => {
    // Red checks: the shapes that slipped past before these were widened.
    const fake = (src: string) => [{ rel: 'fake.tsx', src }]
    expect(styledHeadingOffenders(fake('<div className="text-sm font-medium">Team Members</div>'))).toHaveLength(1)
    expect(styledHeadingOffenders(fake('<p className="font-semibold">Danger Zone</p>'))).toHaveLength(1)
    expect(styledHeadingOffenders(fake('<h5>Recent Runs</h5>'))).toHaveLength(1)
    expect(styledHeadingOffenders(fake('<summary>Advanced Options</summary>'))).toHaveLength(1)
    expect(styledHeadingOffenders(fake('<div className="text-sm font-medium">Team members</div>'))).toEqual([])
    expect(styledHeadingOffenders(fake('<div className="font-medium"><span>A</span> Big Wrapper</div>'))).toEqual([])
    expect(styledHeadingOffenders(fake('<span className="text-sm text-muted-foreground">Total Runs</span>'))).toHaveLength(1)
    expect(styledHeadingOffenders(fake('<div className="flex gap-2"><Plus className="h-4 w-4" /> Add Member</div>'))).toHaveLength(1)
    expect(styledHeadingOffenders(fake('<p>Open a provider. Check It again.</p>'))).toEqual([])
    expect(literalPropOffenders(fake('<FormPage submitLabel="Save Changes" />'))).toHaveLength(1)
    expect(literalPropOffenders(fake("<Field label={'Display Name'} />"))).toHaveLength(1)
    expect(literalPropOffenders(fake("<X title={busy ? 'Saving' : 'Save Changes'} />"))).toHaveLength(1)
    expect(literalPropOffenders(fake('<Button aria-label="Copy Link" />'))).toHaveLength(1)
    expect(literalPropOffenders(fake('<FormPage submitLabel="Save changes" />'))).toEqual([])
    expect(toastTitleOffenders(fake("success('Tools Generated', `${n} made`)"))).toHaveLength(1)
    expect(toastTitleOffenders(fake("notifications.error('Could not save', msg)"))).toEqual([])
  })
})

/**
 * Props that carry a visible or spoken label: label, title, header,
 * heading, any *Label (submitLabel, searchLabel...), aria-label and
 * empty-state text, written as a literal, a braced literal or a ternary
 * of literals.
 */
function literalPropOffenders(files: Array<{ rel: string; src: string }>): string[] {
  const NAME = String.raw`(?:[a-z][A-Za-z]*Label|label|title|header|heading|emptyText|emptyTitle|aria-label)`
  const plain = new RegExp(String.raw`\b(${NAME})(?:=\{?|:\s*)(['"])([^'"\n]+)\2`, 'g')
  const ternary = new RegExp(String.raw`\b(${NAME})=\{[^{}\n]*\?\s*(['"])([^'"\n]*)\2\s*:\s*(['"])([^'"\n]*)\4\s*\}`, 'g')
  const offenders: string[] = []
  for (const { rel, src } of files) {
    for (const m of src.matchAll(plain)) {
      if (titleCaseWords(m[3]).length) offenders.push(`${rel}:${lineAt(src, m.index!)} ${m[1]}: "${m[3]}"`)
    }
    for (const m of src.matchAll(ternary)) {
      for (const label of [m[3], m[5]]) {
        if (titleCaseWords(label).length) offenders.push(`${rel}:${lineAt(src, m.index!)} ${m[1]}: "${label}"`)
      }
    }
  }
  return offenders
}

/**
 * Headings that are not heading elements: a div, p or span made bold
 * ("Team Members" on the team card), plus h5/h6, legend, dt, summary and
 * the menu and sheet titles. Only text-only elements count, so a bold
 * wrapper around other elements is not read as one long label.
 */
function styledHeadingOffenders(files: Array<{ rel: string; src: string }>): string[] {
  const HEADING_TAGS = ['h5', 'h6', 'legend', 'dt', 'summary', 'SheetTitle', 'DrawerTitle', 'DropdownMenuLabel', 'SelectLabel', 'AccordionTrigger', 'CommandItem']
  const TEXT_TAGS = ['div', 'p', 'span', 'strong', 'dd', 'td', 'TableCell', 'Link', 'a']
  const offenders: string[] = []
  for (const { rel, src } of files) {
    for (const el of jsxLabels(src, [...HEADING_TAGS, ...TEXT_TAGS])) {
      if (!HEADING_TAGS.includes(el.tag)) {
        // Only a short, text-only element reads as a label; a wrapper
        // round other elements, or a sentence of body copy, does not.
        if (el.nested) continue
      }
      for (const label of el.variants) {
        const words = label.split(' ').length
        if (words > 10 || (!HEADING_TAGS.includes(el.tag) && (words > 6 || /[.:!?]/.test(label)))) continue
        // "This browser · active now": each side of a separator is its own label.
        for (const part of label.split(/\s[•·|—–]\s/)) {
          if (titleCaseWords(part).length) offenders.push(`${rel}:${el.line} <${el.tag}> "${label}"`)
        }
      }
    }
  }
  return offenders
}

/** success('Tools generated', ...): the first argument of a toast is its title. */
function toastTitleOffenders(files: Array<{ rel: string; src: string }>): string[] {
  const toast = /(?<!console\.)\b(success|error|warning|info)\(\s*(['"])([^'"\n]+)\2\s*[,)]/g
  const offenders: string[] = []
  for (const { rel, src } of files) {
    for (const m of src.matchAll(toast)) {
      if (titleCaseWords(m[3]).length) offenders.push(`${rel}:${lineAt(src, m.index!)} ${m[1]}: "${m[3]}"`)
    }
  }
  return offenders
}

function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

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
