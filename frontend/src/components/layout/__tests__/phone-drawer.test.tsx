import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { render } from '@/test/setup'
import { DashboardLayout } from '../dashboard-layout'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import { useAppStore } from '@/store/app'
import type { Organization, User } from '@/types'

vi.mock('@/lib/api', () => ({
  authApi: { getProfile: vi.fn(() => new Promise(() => {})) },
  organizationsApi: { getAll: vi.fn() },
}))
vi.mock('@/lib/analytics', () => ({ identifyUser: vi.fn(), resetAnalytics: vi.fn() }))
vi.mock('@/components/onboarding/guide-pill', () => ({ GuidePill: () => null }))
vi.mock('@/components/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/keyboard-shortcuts', () => ({ KeyboardShortcutsListener: () => null }))
vi.mock('@/components/notifications/notification-bell', () => ({ NotificationBell: () => null }))
vi.mock('@/components/layout/email-verification-banner', () => ({ EmailVerificationBanner: () => null }))
vi.mock('@/components/plan-indicator', () => ({ PlanBadge: () => null, PlanLine: () => null }))

const org = { id: 'org-1', name: 'Acme' } as Organization
const user = {
  id: 'u1', email: 'qa@example.test',
  organizationMemberships: [{ organization: org, role: 'owner' }],
} as User

/**
 * On a phone (the test setup's matchMedia never matches lg) the sidebar
 * is a drawer. Closed, it must not sit in the Tab order: a keyboard user
 * walked through all of its hidden links after the page content. Open,
 * focus goes into it, the page behind it is inert, and Escape closes it.
 */
describe('phone navigation drawer', () => {
  beforeEach(() => {
    localStorage.clear()
    useOrganizationStore.setState({ organizations: [org], currentOrganization: org, isInitialized: true })
    useAuthStore.setState({ user, isAuthenticated: true, hasHydrated: true, authChecked: true })
    useAppStore.setState({ sidebarOpen: false })
  })

  it('is inert while closed, so its links are out of the Tab order', () => {
    render(<DashboardLayout><div>page</div></DashboardLayout>)
    const drawer = document.getElementById('app-navigation')!
    expect(drawer).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Toggle navigation menu' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('takes focus when opened, makes the page inert, and closes on Escape', () => {
    render(<DashboardLayout><div>page</div></DashboardLayout>)
    const toggle = screen.getByRole('button', { name: 'Toggle navigation menu' })
    fireEvent.click(toggle)

    const drawer = document.getElementById('app-navigation')!
    expect(drawer).not.toHaveAttribute('inert')
    expect(drawer).toHaveAttribute('aria-modal', 'true')
    expect(drawer.contains(document.activeElement)).toBe(true)
    expect(screen.getByRole('main', { hidden: true }).closest('[inert]')).not.toBeNull()

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(useAppStore.getState().sidebarOpen).toBe(false)
    expect(drawer).toHaveAttribute('inert')
    // Focus goes back to the button that opened it.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Toggle navigation menu' }))
  })
})
