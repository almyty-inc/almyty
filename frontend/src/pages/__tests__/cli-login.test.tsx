import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/setup'
import { CliLoginPage } from '../cli-login'
import { authApi } from '@/lib/api'

const orgState = vi.hoisted(() => ({
  currentOrganization: { id: 'one' } as { id: string } | null,
  organizations: [{ id: 'one', name: 'Personal org' }, { id: 'two', name: 'Company org' }],
}))
vi.mock('@/store/auth', () => ({ useAuthStore: () => ({ hasHydrated: true, isAuthenticated: true, user: { email: 'local@test.example' } }) }))
vi.mock('@/store/organization', () => ({ useOrganizationStore: () => orgState }))
vi.mock('@/lib/api', () => ({ authApi: { createApiKey: vi.fn() } }))
vi.mock('react-router-dom', async () => ({ ...(await vi.importActual<any>('react-router-dom')), useLocation: () => ({ pathname: '/cli-login', search: '?callback=http%3A%2F%2F127.0.0.1%3A43210%2Fcb&state=local-test' }) }))

const realLocation = window.location
let navigatedTo = ''

beforeEach(() => {
  navigatedTo = ''
  vi.mocked(authApi.createApiKey).mockReset()
  orgState.currentOrganization = { id: 'one' }
  orgState.organizations = [{ id: 'one', name: 'Personal org' }, { id: 'two', name: 'Company org' }]
  // The page hands the key to the CLI by navigating to the loopback
  // callback; capture that instead of letting jsdom try to navigate.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, set href(v: string) { navigatedTo = v }, get href() { return navigatedTo } },
  })
})
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
})

function handedToCli() {
  return new URLSearchParams(new URL(navigatedTo).hash.slice(1))
}

describe('CLI login organization', () => {
  it('lets a member of several organizations choose one before connecting', async () => {
    renderWithProviders(<CliLoginPage />)
    const org = screen.getByRole('combobox', { name: 'Organization' })
    expect(org).toHaveValue('one')
    await userEvent.setup().selectOptions(org, 'two')
    expect(org).toHaveValue('two')
    expect(authApi.createApiKey).not.toHaveBeenCalled()
  })

  it('scopes the new key to the chosen organization and hands the CLI the same one', async () => {
    vi.mocked(authApi.createApiKey).mockResolvedValue({ apiKey: 'local-test-key', keyData: { organizationId: 'two' } } as any)
    renderWithProviders(<CliLoginPage />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Organization' }), 'two')
    await user.click(screen.getByRole('button', { name: 'Connect CLI' }))

    expect(authApi.createApiKey).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'two' }))
    expect(navigatedTo.startsWith('http://127.0.0.1:43210/cb#')).toBe(true)
    expect(handedToCli().get('organizationId')).toBe('two')
    expect(handedToCli().get('token')).toBe('local-test-key')
  })

  it('does not hand over a key scoped to another organization than the one shown', async () => {
    vi.mocked(authApi.createApiKey).mockResolvedValue({ apiKey: 'local-test-key', keyData: { organizationId: 'one' } } as any)
    renderWithProviders(<CliLoginPage />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Organization' }), 'two')
    await user.click(screen.getByRole('button', { name: 'Connect CLI' }))

    expect(navigatedTo).toBe('')
    expect(await screen.findByText(/not scoped to the organization you chose/)).toBeInTheDocument()
  })

  it('shows the organization of a single-org member and scopes the key to it', async () => {
    orgState.organizations = [{ id: 'one', name: 'Personal org' }]
    vi.mocked(authApi.createApiKey).mockResolvedValue({ apiKey: 'local-test-key', keyData: { organizationId: 'one' } } as any)
    renderWithProviders(<CliLoginPage />)

    expect(screen.queryByRole('combobox', { name: 'Organization' })).not.toBeInTheDocument()
    expect(screen.getByText('Personal org')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect CLI' }))

    expect(authApi.createApiKey).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'one' }))
    expect(handedToCli().get('organizationId')).toBe('one')
  })
})