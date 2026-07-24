import { describe, it, expect, vi, beforeEach } from 'vitest'

import { renderHook, act } from '../../../test/setup'

// Mock driver.js so we can assert the tour is driven without mounting a
// real spotlight into jsdom. `driver()` returns a fake controller whose
// `drive` is a spy and whose `onDestroyed` callback we can trigger.
const driveSpy = vi.fn()
let lastConfig: any = null
let active = false
vi.mock('driver.js', () => ({
  driver: (config: any) => {
    lastConfig = config
    return {
      drive: () => {
        active = true
        driveSpy(config)
      },
      isActive: () => active,
      destroy: () => {
        active = false
        config.onDestroyed?.()
      },
    }
  },
}))

vi.mock('@/lib/analytics', () => ({
  captureEvent: vi.fn(),
}))

import {
  TOUR_STEPS,
  createTour,
  hasSeenTour,
  markTourSeen,
  tourSeenKey,
  useProductTour,
} from '../product-tour'

const USER = 'user-123'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  lastConfig = null
  active = false
})

describe('TOUR_STEPS', () => {
  it('is built with the expected ordered steps', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(['api', 'gateway', 'call'])
  })

  it('anchors each step to a real data-tour element and has copy', () => {
    expect(TOUR_STEPS.map((s) => s.element)).toEqual([
      '[data-tour="nav-api"]',
      '[data-tour="nav-gateway"]',
      '[data-tour="getting-started-first-call"]',
    ])
    for (const step of TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.description.length).toBeGreaterThan(0)
    }
  })

  it('passes the ordered steps through to driver.js', () => {
    createTour(() => {})
    expect(lastConfig.steps).toHaveLength(TOUR_STEPS.length)
    expect(lastConfig.steps.map((s: any) => s.element)).toEqual(
      TOUR_STEPS.map((s) => s.element),
    )
    expect(lastConfig.popoverClass).toBe('almyty-tour')
    expect(lastConfig.showProgress).toBe(true)
  })
})

describe('seen flag', () => {
  it('treats a missing user id as already seen (never nag anon shells)', () => {
    expect(hasSeenTour(undefined)).toBe(true)
  })

  it('round-trips through localStorage under a per-user key', () => {
    expect(hasSeenTour(USER)).toBe(false)
    markTourSeen(USER)
    expect(localStorage.getItem(tourSeenKey(USER))).toBe('1')
    expect(hasSeenTour(USER)).toBe(true)
  })
})

describe('useProductTour', () => {
  it('auto-starts once when onboarding is incomplete and unseen', () => {
    const { result } = renderHook(() => useProductTour(USER))
    let started = false
    act(() => {
      started = result.current.maybeAutoStart(false)
    })
    expect(started).toBe(true)
    expect(driveSpy).toHaveBeenCalledTimes(1)

    // A second call in the same mount is a no-op (runs at most once).
    act(() => {
      result.current.maybeAutoStart(false)
    })
    expect(driveSpy).toHaveBeenCalledTimes(1)
  })

  it('the seen flag suppresses auto-start', () => {
    markTourSeen(USER)
    const { result } = renderHook(() => useProductTour(USER))
    let started = true
    act(() => {
      started = result.current.maybeAutoStart(false)
    })
    expect(started).toBe(false)
    expect(driveSpy).not.toHaveBeenCalled()
  })

  it('does not auto-start once onboarding is complete', () => {
    const { result } = renderHook(() => useProductTour(USER))
    act(() => {
      result.current.maybeAutoStart(true)
    })
    expect(driveSpy).not.toHaveBeenCalled()
  })

  it('manual start ignores the seen flag', () => {
    markTourSeen(USER)
    const { result } = renderHook(() => useProductTour(USER))
    act(() => {
      result.current.startTour({ manual: true })
    })
    expect(driveSpy).toHaveBeenCalledTimes(1)
  })

  it('marks the tour seen when it is dismissed or completed', () => {
    localStorage.clear()
    const { result } = renderHook(() => useProductTour(USER))
    act(() => {
      result.current.startTour({ manual: true })
    })
    expect(hasSeenTour(USER)).toBe(false)
    // driver.js fires onDestroyed on close/complete.
    act(() => {
      lastConfig.onDestroyed()
    })
    expect(hasSeenTour(USER)).toBe(true)
  })
})
