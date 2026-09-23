import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

import type { OnboardingState } from '@/lib/api'
import { GATEWAY_TABS, initialGatewayTab } from '@/pages/gateway-detail'
import {
  ALL_STEPS,
  JOURNEYS,
  SUPPORTING,
  journeyProgress,
  nextStep,
  stepsDone,
  type GuideLink,
  type StepKey,
} from '../guide-steps'

/**
 * The owner's complaint about the old onboarding: a step said "Use it
 * from Claude Code" while its click opened agent creation. These guards
 * make that class of drift fail the build:
 *
 * - every step's link is a route App.tsx actually serves;
 * - the place the guide prints next to the button ("Opens Gateways › …")
 *   names the page that route is, as the sidebar / command palette names it;
 * - no coach-mark anchors remain for text to be pinned to the wrong element.
 */

const SRC = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Every `path="..."` under the dashboard layout in App.tsx, as regexes. */
function appRoutes(): RegExp[] {
  const app = read('App.tsx')
  const paths = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1])
  return paths
    .filter((p) => p.startsWith('/') && p !== '/')
    .map((p) => {
      const body = p
        .replace(/\/\*$/, '(?:/.*)?')
        .replace(/:[A-Za-z]+/g, '[^/]+')
      return new RegExp(`^${body}$`)
    })
}

/** Page name by first path segment, from the sidebar and the command palette. */
function pageNames(): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>()
  const add = (href: string, name: string) => {
    const seg = '/' + href.split('?')[0].split('/')[1]
    if (!names.has(seg)) names.set(seg, new Set())
    names.get(seg)!.add(name)
  }
  const layout = read('components/layout/dashboard-layout.tsx')
  for (const m of layout.matchAll(/\{ name: '([^']+)', href: '(\/[^']*)'/g)) add(m[2], m[1])
  const palette = read('components/command-palette.tsx')
  for (const m of palette.matchAll(/id: 'nav-[^']+', label: '([^']+)'.*?go\('(\/[^']*)'\)/g)) add(m[2], m[1])
  return names
}

const ROUTES = appRoutes()
const NAMES = pageNames()

function isRoute(to: string): boolean {
  const pathname = to.split('?')[0]
  return ROUTES.some((r) => r.test(pathname))
}

function placeMatchesTarget(place: string, to: string): boolean {
  const seg = '/' + to.split('?')[0].split('/')[1]
  const first = place.split(' › ')[0]
  return NAMES.get(seg)?.has(first) ?? false
}

const STEP_KEYS: StepKey[] = [
  'provider', 'api', 'tools', 'gateway', 'first_call', 'external_client',
  'agent', 'agent_run', 'app', 'distribution', 'runner',
]

function state(done: Partial<Record<StepKey, boolean>> = {}, withLinks = false): OnboardingState {
  const steps = Object.fromEntries(STEP_KEYS.map((k) => [k, !!done[k]])) as OnboardingState['steps']
  return {
    steps,
    links: withLinks
      ? {
          gateway: { id: 'gw-1', name: 'Weather', type: 'mcp', endpoint: '/weather' },
          agent: { id: 'ag-1', name: 'Support bot' },
          app: { slug: 'helpdesk', name: 'Helpdesk' },
        }
      : { gateway: null, agent: null, app: null },
    dismissed: false,
    dismissedIntros: [],
    activatedRealAt: null,
  }
}

const SCENARIOS = [
  ['a brand-new account', state()],
  ['an account with a gateway, an agent and an app', state({ api: true, gateway: true, agent: true, app: true }, true)],
] as const

describe('guide steps: the words match the link', () => {
  it('reads the route table and the page names it checks against', () => {
    // A broken parser would make every assertion below vacuous.
    expect(ROUTES.length).toBeGreaterThan(20)
    expect(NAMES.get('/gateways')?.has('Gateways')).toBe(true)
    expect(NAMES.get('/chat')?.has('Chat')).toBe(true)
  })

  for (const [label, s] of SCENARIOS) {
    describe(label, () => {
      for (const step of ALL_STEPS) {
        it(`"${step.title}" links to a real route and says which page it opens`, () => {
          const target = step.target(s)
          expect(isRoute(target.to), `${target.to} is not a route in App.tsx`).toBe(true)
          expect(
            placeMatchesTarget(target.place, target.to),
            `"${target.place}" does not name the page ${target.to} opens`,
          ).toBe(true)
        })
      }

      const links: GuideLink[] = [...SUPPORTING, ...JOURNEYS.flatMap((j) => j.more?.(s) ?? [])]
      for (const link of links) {
        it(`"${link.title}" links to a real route named ${link.place}`, () => {
          expect(isRoute(link.to)).toBe(true)
          expect(placeMatchesTarget(link.place, link.to)).toBe(true)
        })
      }
    })
  }

  it('catches a step whose words name another page', () => {
    // Red-check of the guard itself: the old tour's mismatch.
    expect(placeMatchesTarget('Gateways › Integrations', '/agents/new')).toBe(false)
    expect(isRoute('/guides/everything')).toBe(false)
  })

  it('sends "connect a client" to that gateway\'s Integrations tab, which exists', () => {
    const step = ALL_STEPS.find((x) => x.key === 'external_client')!
    const target = step.target(state({}, true))
    expect(target.to).toBe('/gateways/gw-1?tab=integrations')
    expect(target.place).toBe('Gateways › Weather › Integrations')
    expect(GATEWAY_TABS).toContain('integrations')
    expect(initialGatewayTab('integrations', false)).toBe('integrations')
  })

  it('names the org\'s own agent and app when the step is about them', () => {
    const s = state({ agent: true, app: true }, true)
    const run = ALL_STEPS.find((x) => x.key === 'agent_run')!
    expect(run.target(s)).toEqual({ to: '/agents/ag-1', place: 'Agents › Support bot' })
    expect(run.description(s)).toContain('Support bot')
    const ship = ALL_STEPS.find((x) => x.key === 'distribution')!
    expect(ship.target(s).to).toBe('/apps/helpdesk')
  })
})

describe('guide steps: done comes from the server', () => {
  it('only uses keys the backend computes', () => {
    for (const step of ALL_STEPS) expect(STEP_KEYS).toContain(step.key)
    // And every backend-derived fact the guide can use is used, bar the
    // activation marker that the external-client step already implies.
    const used = new Set(ALL_STEPS.map((s) => s.key))
    expect(STEP_KEYS.filter((k) => !used.has(k))).toEqual(['first_call'])
  })

  it('has no step twice', () => {
    const keys = ALL_STEPS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers the whole platform, not three lines', () => {
    expect(JOURNEYS.map((j) => j.title)).toEqual([
      'Give an AI your API',
      'Build an agent',
      'Put it where people are',
      'Run it on your machines',
    ])
    expect(ALL_STEPS.length).toBe(10)
  })

  it('counts done steps from state', () => {
    expect(stepsDone(state())).toBe(0)
    expect(stepsDone(state({ api: true, runner: true, first_call: true }))).toBe(2)
    const p = journeyProgress(state({ runner: true }))
    expect(p.find((x) => x.journey.id === 'runner')).toMatchObject({ done: 1, total: 1, complete: true })
  })
})

describe('nextStep', () => {
  it('starts a new account at importing an API', () => {
    expect(nextStep(state())?.step.key).toBe('api')
  })

  it('stays in the journey someone started rather than the first one listed', () => {
    const n = nextStep(state({ provider: true }))
    expect(n?.journey.id).toBe('agent')
    expect(n?.step.key).toBe('agent')
  })

  it('suggests the first undone step even when later ones are done', () => {
    expect(nextStep(state({ api: true, gateway: true }))?.step.key).toBe('tools')
  })

  it('moves to the next journey once one is finished', () => {
    const n = nextStep(state({ api: true, tools: true, gateway: true, external_client: true }))
    expect(n?.journey.id).toBe('agent')
  })

  it('is null when everything is done', () => {
    const all = Object.fromEntries(STEP_KEYS.map((k) => [k, true]))
    expect(nextStep(state(all))).toBeNull()
  })
})

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full)
    return /\.(tsx?|css)$/.test(name) ? [full] : []
  })
}

describe('the coach-mark tour is gone', () => {
  // The tour anchored "Use it from Claude Code" to a row that opened agent
  // creation. The guide replaces it; nothing may pin text to an element again.
  const files = sources(SRC)

  it('leaves no data-tour anchors behind', () => {
    expect(files.filter((f) => readFileSync(f, 'utf8').includes('data-tour'))).toEqual([])
  })

  it('does not import driver.js anywhere', () => {
    expect(files.filter((f) => /from 'driver\.js'|driver\.js\/dist/.test(readFileSync(f, 'utf8')))).toEqual([])
  })
})
