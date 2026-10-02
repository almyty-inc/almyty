import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test/setup'
import { GatewayAuthSection } from '../gateway-auth-section'
import { gatewaysApi } from '@/lib/api'
vi.mock('@/components/credentials/credential-picker', () => ({ CredentialPicker: ({ onChange }: any) => <button type="button" onClick={() => onChange({ id: 'directory-key' })}>Choose Directory credential</button> }))
vi.mock('@/lib/api', () => ({ gatewaysApi: {
  getAuthConfigs: vi.fn(), listApiKeys: vi.fn(), createAuthConfig: vi.fn(), updateAuthConfig: vi.fn(),
  getCompanySignInMetadata: vi.fn(), generateApiKey: vi.fn(), revokeApiKey: vi.fn(),
} }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([])
  vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([])
})
describe('outside protected methods', () => {
  it('offers the four agreed methods together', async () => {
    render(<GatewayAuthSection gatewayId="gw-1" />)
    for (const label of ['Keys', 'Usernames and passwords', 'Company sign-in', 'Tokens from your own system'])
      expect(await screen.findByRole('checkbox', { name: label })).toBeInTheDocument()
    expect(screen.queryByText('None (Public)')).not.toBeInTheDocument()
  })
  it('makes a named key with an expiry and only shows the secret once', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([{ id: 'auth-1', type: 'api_key', isActive: true, configuration: {} }])
    vi.mocked(gatewaysApi.generateApiKey).mockResolvedValue({ key: 'gw_one_time_secret' })
    render(<GatewayAuthSection gatewayId="gw-1" />)
    await user.click(await screen.findByRole('button', { name: 'New key' }))
    const form = screen.getByRole('form', { name: 'New key' })
    await user.type(within(form).getByLabelText('Name'), 'Partner')
    await user.type(within(form).getByLabelText('Expires on'), '2026-12-31')
    await user.click(within(form).getByRole('button', { name: 'Make key' }))
    await waitFor(() => expect(gatewaysApi.generateApiKey).toHaveBeenCalledWith('gw-1', { name: 'Partner', expiresAt: '2026-12-31T23:59:59.999Z' }))
    const shown = await screen.findByTestId('generated-api-key')
    expect(shown).toHaveTextContent('gw_one_time_secret')
    await user.click(within(shown).getByRole('button', { name: "I've saved it" }))
    expect(screen.queryByText('gw_one_time_secret')).not.toBeInTheDocument()
  })
  it('saves a managed username list without disabling other methods', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.createAuthConfig).mockResolvedValue({})
    render(<GatewayAuthSection gatewayId="gw-1" />)
    await user.click(await screen.findByRole('checkbox', { name: 'Usernames and passwords' }))
    await user.type(screen.getByLabelText('Username'), 'partner')
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Save usernames and passwords' }))
    await waitFor(() => expect(gatewaysApi.createAuthConfig).toHaveBeenCalledWith('gw-1', expect.objectContaining({ type: 'basic_auth', configuration: { users: [{ username: 'partner', password: 'correct-horse-battery', isActive: true }] } })))
    expect(gatewaysApi.updateAuthConfig).not.toHaveBeenCalled()
  })

  it('configures company sign-in with domain and group restrictions and a write-only secret', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.getCompanySignInMetadata).mockResolvedValue({ redirectUri: 'https://api.example/company-signin/gw-1/callback' })
    vi.mocked(gatewaysApi.createAuthConfig).mockResolvedValue({})
    render(<GatewayAuthSection gatewayId="gw-1" />)
    await user.click(await screen.findByRole('checkbox', { name: 'Company sign-in' }))
    await user.type(screen.getByLabelText('Client ID'), 'company-client')
    await user.type(screen.getByLabelText('Client secret'), 'fake-test-secret')
    await user.type(screen.getByLabelText('Allowed email domains'), 'acme.example, partner.example')
    await user.type(screen.getByLabelText('Allowed groups'), 'Support, Operators')
    await user.click(screen.getByRole('button', { name: 'Save company sign-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a Google Directory credential')
    expect(gatewaysApi.createAuthConfig).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Choose Directory credential' }))
    await user.type(screen.getByLabelText('Delegated administrator email'), 'admin@acme.example')
    await user.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(await screen.findByText('https://api.example/company-signin/gw-1/callback')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save company sign-in' }))
    await waitFor(() => expect(gatewaysApi.createAuthConfig).toHaveBeenCalledWith('gw-1', expect.objectContaining({ type: 'company_signin', configuration: expect.objectContaining({ preset: 'google', directoryCredentialId: 'directory-key', directoryAdminEmail: 'admin@acme.example', clientId: 'company-client', clientSecret: 'fake-test-secret', allowedEmailDomains: ['acme.example', 'partner.example'], allowedGroups: ['Support', 'Operators'] }) })))
    expect(screen.queryByDisplayValue('fake-test-secret')).not.toBeInTheDocument()
  })
})
