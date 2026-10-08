import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/setup'
import { CliLoginPage } from '../cli-login'
import { authApi } from '@/lib/api'
vi.mock('@/store/auth', () => ({ useAuthStore: () => ({ hasHydrated: true, isAuthenticated: true, user: { email: 'local@test.example' } }) }))
vi.mock('@/store/organization', () => ({ useOrganizationStore: () => ({ currentOrganization: { id: 'one' }, organizations: [{ id: 'one', name: 'Personal org' }, { id: 'two', name: 'Company org' }] }) }))
vi.mock('@/lib/api', () => ({ authApi: { createApiKey: vi.fn() } }))
vi.mock('react-router-dom', async () => ({ ...(await vi.importActual<any>('react-router-dom')), useLocation: () => ({ pathname: '/cli-login', search: '?callback=http%3A%2F%2F127.0.0.1%3A43210%2Fcb&state=local-test' }) }))

describe('CLI login organization', () => {
  it('lets a member of several organizations choose one before connecting', async () => {
    renderWithProviders(<CliLoginPage />)
    const org = screen.getByRole('combobox', { name: 'Organization' })
    expect(org).toHaveValue('one')
    await userEvent.setup().selectOptions(org, 'two')
    expect(org).toHaveValue('two')
    expect(authApi.createApiKey).not.toHaveBeenCalled()
  })
})
