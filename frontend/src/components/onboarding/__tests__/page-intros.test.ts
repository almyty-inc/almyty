import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { PAGE_INTROS, PAGE_INTRO_TOPICS } from '../page-intros'

/**
 * An intro nobody renders is the dominant defect class here: it compiles,
 * its tests pass, and no page shows it. These read the sources.
 */
const SRC = join(__dirname, '..', '..', '..')
const REPO = join(SRC, '..', '..')

/** The page component file that serves each intro's route. */
function pageFileFor(route: string): string {
  const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
  const el = app.match(new RegExp(`<Route path="${route}(?:/\\*)?" element=\\{<(\\w+)`))?.[1]
  expect(el, `no route ${route} in App.tsx`).toBeTruthy()
  const file =
    app.match(new RegExp(`const ${el} = lazy\\(\\(\\) => import\\('@/pages/([\\w-]+)'\\)`))?.[1] ??
    app.match(new RegExp(`import \\{ ${el} \\} from '@/pages/([\\w-]+)'`))?.[1]
  expect(file, `no lazy import for ${el}`).toBeTruthy()
  return join(SRC, 'pages', `${file}.tsx`)
}

describe('page intros', () => {
  for (const topic of PAGE_INTRO_TOPICS) {
    const { page } = PAGE_INTROS[topic]
    it(`${page} renders its own intro, right under its header`, () => {
      const src = readFileSync(pageFileFor(page), 'utf8')
      expect(src).toContain(`<PageIntro topic="${topic}" />`)
      // Other topics do not leak onto this page.
      for (const other of PAGE_INTRO_TOPICS.filter((t) => t !== topic)) {
        expect(src).not.toContain(`<PageIntro topic="${other}" />`)
      }
    })
  }

  it('covers the pages the guide promises', () => {
    expect([...PAGE_INTRO_TOPICS].sort()).toEqual(
      ['agents', 'apis', 'apps', 'credentials', 'gateways', 'memories', 'models', 'runners', 'tools'],
    )
  })

  it('matches the topics the backend accepts a dismissal for', () => {
    const dto = readFileSync(
      join(REPO, 'backend', 'src', 'modules', 'onboarding', 'dto', 'onboarding.dto.ts'),
      'utf8',
    )
    const block = dto.match(/PAGE_INTRO_TOPICS = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    const backend = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
    expect(backend).toEqual([...PAGE_INTRO_TOPICS].sort())
  })

  it('says it in plain words: no internal names, ids or jargon', () => {
    for (const topic of PAGE_INTRO_TOPICS) {
      const text = PAGE_INTROS[topic].text
      expect(text).not.toMatch(/\b(entity|uuid|org id|organizationId|DAG|payload|endpoint|JSON)\b/i)
      expect(text.length).toBeLessThan(200)
    }
  })

  // An intro that restates the subtitle under it is noise. Four words in a
  // row shared with the page's own description is a restatement.
  it('adds to the page subtitle instead of repeating it', () => {
    const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    const runs = (s: string) => {
      const w = words(s)
      return new Set(w.slice(0, -3).map((_, i) => w.slice(i, i + 4).join(' ')))
    }
    for (const topic of PAGE_INTRO_TOPICS) {
      const { page, text } = PAGE_INTROS[topic]
      const src = readFileSync(pageFileFor(page), 'utf8')
      const subtitle = src.match(/<PageHeader[\s\S]*?description="([^"]+)"/)?.[1]
      if (!subtitle) continue
      const shared = [...runs(text)].filter((r) => runs(subtitle).has(r))
      expect(shared, `${topic} intro repeats its subtitle`).toEqual([])
    }
  })
})
