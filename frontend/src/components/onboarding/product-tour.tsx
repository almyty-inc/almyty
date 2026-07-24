import { useCallback, useRef } from 'react'
import { driver, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import './product-tour.css'

import { captureEvent } from '@/lib/analytics'

/**
 * A single spotlight step. `id` aligns with the onboarding step keys
 * (see `useOnboarding`) so the two stay conceptually paired.
 */
export interface TourStep {
  id: 'provider' | 'api' | 'gateway' | 'call'
  /** CSS selector for the element the popover anchors to. */
  element: string
  title: string
  description: string
}

/**
 * The coach-mark tour, in fixed order. Each step anchors to a real
 * element carrying a `data-tour` attribute: the sidebar nav items live
 * in `components/layout/dashboard-layout.tsx`, and the "first call" row
 * lives in the getting-started card. Copy is CLI-forward, payoff-first,
 * lowercase almyty, no em-dash, no emoji (per docs-site STYLE.md).
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'provider',
    element: '[data-tour="nav-provider"]',
    title: 'Connect a model',
    description:
      'Start here. Connect an LLM provider (OpenAI, Anthropic, or keyless local Ollama). It powers agents and tool generation.',
  },
  {
    id: 'api',
    element: '[data-tour="nav-api"]',
    title: 'Turn an API into tools',
    description:
      'Import an OpenAPI, GraphQL, SOAP, or Protobuf schema and every operation becomes a typed tool. No code.',
  },
  {
    id: 'gateway',
    element: '[data-tour="nav-gateway"]',
    title: 'Publish a gateway',
    description:
      'One endpoint that serves your tools over MCP, A2A, UTCP, and Agent Skills.',
  },
  {
    id: 'call',
    element: '[data-tour="getting-started-first-call"]',
    title: 'Use it from Claude Code',
    description:
      'Run `claude mcp add` with your gateway URL and your tools show up in Claude Code.',
  },
]

/** localStorage key prefix for the per-user "tour seen" flag. */
export const TOUR_SEEN_PREFIX = 'almyty.tour.seen.'

export function tourSeenKey(userId: string): string {
  return `${TOUR_SEEN_PREFIX}${userId}`
}

/**
 * Whether this user has already seen or dismissed the tour. A missing
 * user id is treated as "seen" so an anonymous shell is never auto-nagged.
 * This is a boolean flag only — never an auth token (see CLAUDE.md).
 */
export function hasSeenTour(userId: string | undefined): boolean {
  if (!userId) return true
  try {
    return localStorage.getItem(tourSeenKey(userId)) === '1'
  } catch {
    // Storage disabled (private mode): fail open so the tour still shows.
    return false
  }
}

export function markTourSeen(userId: string | undefined): void {
  if (!userId) return
  try {
    localStorage.setItem(tourSeenKey(userId), '1')
  } catch {
    /* ignore storage write failures */
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Builds a configured driver.js instance for the product tour. driver.js
 * supplies Next/Back, a close button, a step counter, and keyboard
 * navigation (arrows + esc) out of the box. Extracted so tests can assert
 * the wiring without driving a live DOM.
 *
 * `onDone` fires on completion AND on skip/close — either way the tour is
 * considered "seen" and must not auto-start again.
 */
export function createTour(onDone: () => void): Driver {
  const reduce = prefersReducedMotion()
  return driver({
    showProgress: true,
    progressText: 'Step {{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    popoverClass: 'almyty-tour',
    animate: !reduce,
    smoothScroll: !reduce,
    allowClose: true,
    overlayOpacity: 0.6,
    steps: TOUR_STEPS.map((s) => ({
      element: s.element,
      popover: { title: s.title, description: s.description },
    })),
    onDestroyed: () => onDone(),
  })
}

export interface StartTourOptions {
  /** Manual starts ignore the seen flag; auto-starts respect it. */
  manual?: boolean
}

/**
 * Controller hook. `startTour` runs the spotlight and marks it seen when
 * it ends. `maybeAutoStart` runs it at most once per mount, and only when
 * onboarding is incomplete and the user has not already seen it.
 */
export function useProductTour(userId: string | undefined) {
  const activeRef = useRef<Driver | null>(null)
  const autoStartedRef = useRef(false)

  const startTour = useCallback(
    (opts: StartTourOptions = {}) => {
      // Guard against a double-drive (e.g. two quick button clicks).
      if (activeRef.current?.isActive()) return
      const d = createTour(() => {
        markTourSeen(userId)
        activeRef.current = null
      })
      activeRef.current = d
      captureEvent('onboarding_tour_started', { manual: !!opts.manual })
      d.drive()
    },
    [userId],
  )

  const maybeAutoStart = useCallback(
    (onboardingComplete: boolean): boolean => {
      if (autoStartedRef.current) return false
      if (onboardingComplete) return false
      if (hasSeenTour(userId)) return false
      autoStartedRef.current = true
      startTour({ manual: false })
      return true
    },
    [userId, startTour],
  )

  return { startTour, maybeAutoStart }
}
