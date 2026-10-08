import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test/setup'
import { GatewayAuthSection } from '../gateway-auth-section'
import { gatewaysApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({ gatewaysApi: {
  getAuthConfigs: vi.fn(), listApiKeys: vi.fn(), createAuthConfig: vi.fn(), updateAuthConfig: vi.fn(),
  getCompanySignInMetadata: vi.fn(), generateApiKey: vi.fn(), revokeApiKey: vi.fn(),
} }))
const config = { id: 'auth-1', type: 'api_key', isActive: true, configuration: { keyHeader: 'x-api-key' } }
const keys = [{ id: 'key-1', name: 'Partner', keyPrefix: 'gw_prefix', isActive: true, expiresAt: null, lastUsedAt: null }]
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([config])
  vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue(keys)
})
describe('GatewayAuthSection keys and method controls', () => {
  it('renders keys returned as a bare array (Array.prototype.keys must not swallow them)', async () => {
    render(<GatewayAuthSection gatewayId="gw-1" />)
    expect(await screen.findByText('Partner')).toBeInTheDocument()
    expect(screen.getByText('Never used')).toBeInTheDocument()
    expect(screen.getByText('No expiry')).toBeInTheDocument()
  })
  it('also renders keys nested under keys', async () => {
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue({ keys })
    render(<GatewayAuthSection gatewayId="gw-1" />)
    expect(await screen.findByText('Partner')).toBeInTheDocument()
  })
  it('shows a real empty state', async () => {
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([])
    render(<GatewayAuthSection gatewayId="gw-1" />)
    expect(await screen.findByText('No keys yet.')).toBeInTheDocument()
  })
  it('turns off one method without deleting its configuration or changing the others', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.updateAuthConfig).mockResolvedValue({})
    render(<GatewayAuthSection gatewayId="gw-1" />)
    await user.click(await screen.findByRole('checkbox', { name: 'Keys' }))
    await waitFor(() => expect(gatewaysApi.updateAuthConfig).toHaveBeenCalledWith('gw-1', 'auth-1', { isActive: false }))
    expect(gatewaysApi.updateAuthConfig).toHaveBeenCalledTimes(1)
  })
  it('shows fetch errors instead of pretending no sign-in methods exist', async () => {
    vi.mocked(gatewaysApi.getAuthConfigs).mockRejectedValue(new Error('offline'))
    render(<GatewayAuthSection gatewayId="gw-1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in methods could not be loaded.')
  })
})
