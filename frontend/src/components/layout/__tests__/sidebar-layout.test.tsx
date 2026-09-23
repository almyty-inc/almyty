import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { render } from '@/test/setup'
import { DashboardLayout } from '../dashboard-layout'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import type { Organization, User } from '@/types'

vi.mock('@/lib/api', () => ({
  authApi: { getProfile: vi.fn(() => new Promise(() => {})) },
  organizationsApi: { getAll: vi.fn() },
}))
vi.mock('@/lib/analytics', () => ({ identifyUser: vi.fn(), resetAnalytics: vi.fn() }))
vi.mock('@/components/onboarding/setup-pill', () => ({
  SetupPill: () => <button type="button">Setup 1/3</button>,
}))
vi.mock('@/components/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/keyboard-shortcuts', () => ({ KeyboardShortcutsListener: () => null }))
vi.mock('@/components/notifications/notification-bell', () => ({ NotificationBell: () => null }))
vi.mock('@/components/layout/email-verification-banner', () => ({ EmailVerificationBanner: () => null }))
vi.mock('@/components/plan-indicator', () => ({ PlanBadge: () => null }))

const org = { id: 'org-1', name: 'Acme' } as Organization
const user = {
  id: 'u1', email: 'qa@example.test',
  organizationMemberships: [{ organization: org, role: 'owner' }],
} as User

/**
 * The sidebar is three stacked parts: a fixed header (logo, org switcher,
 * search), the nav, and a fixed footer (setup progress, user, collapse).
 *
 * It used to let the nav scroll up under the search box on a short
 * window, left the collapse chevron alone in an empty band of its own,
 * and boxed the setup progress in a bordered cyan pill. These pin the
 * structure that keeps it from drifting back.
 */
describe('dashboard sidebar layout', () => {
  beforeEach(() => {
    localStorage.clear()
    useOrganizationStore.setState({ organizations: [org], currentOrganization: org, isInitialized: true })
    useAuthStore.setState({ user, isAuthenticated: true, hasHydrated: true, authChecked: true })
  })

  it('scrolls only the nav, and lets it shrink inside the column', () => {
    render(<DashboardLayout><div>page</div></DashboardLayout>)
    const nav = screen.getByTestId('sidebar-nav')
    expect(nav).toHaveClass('overflow-y-auto', 'min-h-0', 'flex-1')

    // Every sibling of the nav is fixed height: nothing else scrolls or
    // shrinks, so neither the header nor the footer can overlap the list.
    const siblings = Array.from(nav.parentElement!.children).filter((el) => el !== nav)
    expect(siblings.length).toBeGreaterThanOrEqual(3)
    for (const el of siblings) {
      expect(el.className).toMatch(/flex-shrink-0/)
      expect(el.className).not.toMatch(/overflow-y-auto/)
    }
  })

  it('keeps the collapse control on the user row in the footer', () => {
    render(<DashboardLayout><div>page</div></DashboardLayout>)
    const footer = screen.getByTestId('sidebar-footer')
    const toggle = within(footer).getByRole('button', { name: 'Collapse sidebar' })
    const userMenu = within(footer).getByRole('button', { name: 'User menu' })
    // Same row: the toggle and the user button share a parent.
    expect(toggle.parentElement).toBe(userMenu.parentElement)
    // And there is exactly one collapse control in the whole sidebar.
    expect(screen.getAllByRole('button', { name: /collapse sidebar|expand sidebar/i })).toHaveLength(1)
  })

  it('puts setup progress in the footer, above the user row', () => {
    render(<DashboardLayout><div>page</div></DashboardLayout>)
    const footer = screen.getByTestId('sidebar-footer')
    const setup = within(footer).getByRole('button', { name: 'Setup 1/3' })
    const userMenu = within(footer).getByRole('button', { name: 'User menu' })
    expect(setup.compareDocumentPosition(userMenu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
