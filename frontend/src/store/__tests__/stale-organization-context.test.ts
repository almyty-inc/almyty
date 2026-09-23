import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  ORG_CONTEXT_RECOVERY_KEY,
  ORG_STORE_KEY,
  armOrganizationContextRecovery,
  isStaleOrganizationContext,
  recoverFromStaleOrganizationContext,
} from '@/store/organization-selection'

/**
 * A stale `X-Organization-Id` used to come back as 401, which the
 * response interceptor reads as a dead session: it clears local auth
 * state and sends the browser to /auth/login. So one wrong header — the
 * previous session's organization, an organization whose invite was
 * revoked — signed the user out moments after they signed in, which is
 * what "double login" looked like from the outside.
 *
 * The backend answers 403 ORGANIZATION_CONTEXT_INVALID now. This is the
 * client half: recognise that code, throw away the selection that caused
 * it, and reload once so the app re-derives the organization from the
 * profile. The session is never touched.
 */

const reload = vi.fn()

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  reload.mockClear()
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload, pathname: '/dashboard' },
    writable: true,
    configurable: true,
  })
  armOrganizationContextRecovery()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('isStaleOrganizationContext', () => {
  it('recognises the backend code', () => {
    expect(isStaleOrganizationContext(403, 'ORGANIZATION_CONTEXT_INVALID')).toBe(true)
  })

  it('is not every 403 — an ordinary permission refusal must still toast', () => {
    expect(isStaleOrganizationContext(403, 'FORBIDDEN')).toBe(false)
    expect(isStaleOrganizationContext(403, undefined)).toBe(false)
    expect(isStaleOrganizationContext(403, 'EMAIL_NOT_VERIFIED')).toBe(false)
  })

  /**
   * The load-bearing one. If a stale org context ever comes back as 401
   * again, the interceptor's sign-out branch claims it first and the
   * user is bounced to the login page — the bug this whole change is
   * about.
   */
  it('does not treat a 401 as a recoverable organization problem', () => {
    expect(isStaleOrganizationContext(401, 'ORGANIZATION_CONTEXT_INVALID')).toBe(false)
  })
})

describe('recoverFromStaleOrganizationContext', () => {
  it('drops the refused organization selection', () => {
    localStorage.setItem(
      ORG_STORE_KEY,
      JSON.stringify({ state: { currentOrganization: { id: 'org-refused' } } }),
    )

    recoverFromStaleOrganizationContext()

    expect(localStorage.getItem(ORG_STORE_KEY)).toBeNull()
  })

  it('reloads so the app re-derives the organization, instead of signing out', () => {
    expect(recoverFromStaleOrganizationContext()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves the session alone — no auth state is cleared', () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u-1' }))
    localStorage.setItem('auth-storage', JSON.stringify({ state: { isAuthenticated: true } }))

    recoverFromStaleOrganizationContext()

    expect(localStorage.getItem('user')).not.toBeNull()
    expect(localStorage.getItem('auth-storage')).not.toBeNull()
  })

  /**
   * The marker outlives the reload it causes, so a backend that keeps
   * refusing cannot turn recovery into a reload loop — the same failure
   * mode the 401 branch already carries a comment about.
   */
  it('reloads at most once per tab', () => {
    expect(recoverFromStaleOrganizationContext()).toBe(true)
    expect(sessionStorage.getItem(ORG_CONTEXT_RECOVERY_KEY)).not.toBeNull()

    expect(recoverFromStaleOrganizationContext()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('still clears the selection on the second refusal, reload or not', () => {
    recoverFromStaleOrganizationContext()
    localStorage.setItem(
      ORG_STORE_KEY,
      JSON.stringify({ state: { currentOrganization: { id: 'org-refused' } } }),
    )

    recoverFromStaleOrganizationContext()

    expect(localStorage.getItem(ORG_STORE_KEY)).toBeNull()
  })

  it('rearms on a fresh sign-in, and only there', () => {
    recoverFromStaleOrganizationContext()
    expect(recoverFromStaleOrganizationContext()).toBe(false)

    // Only an explicit sign-in rearms. Rearming on every successful
    // response would let a 200 / 403 alternation reload forever.
    armOrganizationContextRecovery()

    expect(recoverFromStaleOrganizationContext()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
