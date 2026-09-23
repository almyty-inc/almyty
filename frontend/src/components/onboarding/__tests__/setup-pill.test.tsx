import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '@/test/setup'

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ onboardingApi: { setDismissed: vi.fn() } }))
vi.mock('../getting-started-card', () => ({
  CORE_STEPS: [{ key: 'provider' }, { key: 'api' }, { key: 'gateway' }],
  useOnboarding: () => ({
    data: {
      steps: { provider: true, api: true, gateway: false, first_call: false, external_client: false },
      activatedRealAt: null,
    },
  }),
}))

import { SetupPill } from '../setup-pill'

describe('sidebar setup progress', () => {
  it('reads as a sidebar row, not a bordered cyan box', () => {
    render(<SetupPill />)
    const row = screen.getByRole('button', { name: /setup 2\/3/i })
    // The same shape as a nav link: padding, text size, neutral hover.
    expect(row).toHaveClass('px-3', 'py-1.5', 'text-[13px]', 'hover:bg-accent')
    expect(row.className).not.toMatch(/\bborder\b|border-cyan|bg-cyan/)
    expect(row).toHaveTextContent('Finish setup')
    expect(row).toHaveTextContent('2/3')
  })

  it('collapses to an icon the size of the nav icons', () => {
    render(<SetupPill collapsed />)
    const row = screen.getByRole('button', { name: /setup 2\/3/i })
    expect(row).toHaveClass('justify-center', 'px-2', 'py-2')
    expect(row).not.toHaveTextContent('Finish setup')
  })
})
