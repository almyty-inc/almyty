import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test/setup'
import { GatewayAuthSection } from '../gateway-auth-section'
import { gatewaysApi } from '@/lib/api'

// Regression test for the API-keys list rendering empty even though the
// endpoint returned keys. listApiKeys resolves to a bare array; the old
// extraction probed `keysData?.keys` first, which on an array resolves to
// Array.prototype.keys (a function, truthy) and collapsed the list to [].

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getAuthConfigs: vi.fn(),
    listApiKeys: vi.fn(),
    createAuthConfig: vi.fn(),
    deleteAuthConfig: vi.fn(),
    generateApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  },
}))

const apiKeyAuthConfig = {
  id: 'auth-1',
  type: 'api_key',
  configuration: { keyHeader: 'x-api-key' },
}

const keys = [
  {
    id: 'key-1',
    name: 'qa-tour-mcp',
    keyPrefix: 'gw_z0COW',
    gatewayId: 'gw-1',
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    scopes: ['gateway:use'],
    createdAt: '2026-06-11T17:47:43.023Z',
  },
  {
    id: 'key-2',
    name: 'Default Key',
    keyPrefix: 'gw_vyjDE',
    gatewayId: 'gw-1',
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    scopes: ['gateway:use'],
    createdAt: '2026-06-11T17:46:15.919Z',
  },
]

describe('GatewayAuthSection API keys list', () => {
  beforeEach(() => {
    vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([apiKeyAuthConfig])
  })

  it('renders keys returned as a bare array', async () => {
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue(keys)

    render(<GatewayAuthSection gatewayId="gw-1" />)

    await waitFor(() => {
      expect(screen.getByText('qa-tour-mcp')).toBeInTheDocument()
    })
    expect(screen.getByText('Default Key')).toBeInTheDocument()
    expect(screen.queryByText(/No API keys yet/i)).not.toBeInTheDocument()
  })

  it('still renders keys nested under a keys field', async () => {
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue({ keys } as any)

    render(<GatewayAuthSection gatewayId="gw-1" />)

    await waitFor(() => {
      expect(screen.getByText('qa-tour-mcp')).toBeInTheDocument()
    })
  })

  it('shows the empty state when there are no keys', async () => {
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([])

    render(<GatewayAuthSection gatewayId="gw-1" />)

    await waitFor(() => {
      expect(screen.getByText(/No API keys yet/i)).toBeInTheDocument()
    })
  })
})

describe('GatewayAuthSection inline forms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any
      Element.prototype.setPointerCapture = vi.fn() as any
      Element.prototype.releasePointerCapture = vi.fn() as any
    }
    vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([apiKeyAuthConfig])
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([])
  })

  it('generates a key inline and shows it once, with a copy button', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.generateApiKey).mockResolvedValue({ key: 'gw_full_secret_value' } as any)
    render(<GatewayAuthSection gatewayId="gw-1" gatewayName="Petstore" />)

    await user.click(await screen.findByRole('button', { name: /Generate key/ }))
    const form = screen.getByRole('form', { name: 'Generate API key' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.type(within(form).getByLabelText('Key name'), 'CI')
    await user.click(within(form).getByRole('button', { name: 'Generate key' }))

    await waitFor(() => expect(gatewaysApi.generateApiKey).toHaveBeenCalledWith('gw-1', { name: 'CI' }))
    const shown = await screen.findByTestId('generated-api-key')
    expect(shown).toHaveTextContent('gw_full_secret_value')
    expect(shown).toHaveTextContent(/won't see it again/)
    expect(within(shown).getByRole('button', { name: /copy api key/i })).toBeInTheDocument()

    await user.click(within(shown).getByRole('button', { name: "I've saved it" }))
    expect(screen.queryByText('gw_full_secret_value')).toBeNull()
  })

  it('adds an auth method inline, and says so when none is chosen', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([])
    vi.mocked(gatewaysApi.createAuthConfig).mockResolvedValue({} as any)
    render(<GatewayAuthSection gatewayId="gw-1" gatewayName="Petstore" />)

    await user.click(await screen.findByRole('button', { name: /Add auth method/ }))
    const form = screen.getByRole('form', { name: 'Add authentication method' })
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(within(form).getByRole('button', { name: 'Add auth method' }))
    expect(await within(form).findByText('Choose how clients authenticate.')).toBeInTheDocument()
    expect(gatewaysApi.createAuthConfig).not.toHaveBeenCalled()

    await user.click(within(form).getByLabelText(/^Method/))
    await user.click(await screen.findByRole('option', { name: 'Bearer Token' }))
    await user.click(within(form).getByRole('button', { name: 'Add auth method' }))

    await waitFor(() =>
      expect(gatewaysApi.createAuthConfig).toHaveBeenCalledWith('gw-1', { type: 'bearer_token', configuration: {} }),
    )
  })
})
describe('GatewayAuthSection remove auth method', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([apiKeyAuthConfig])
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([])
  })

  const openRemove = async () => {
    const user = userEvent.setup()
    render(<GatewayAuthSection gatewayId="gw-1" gatewayName="Petstore" />)
    await user.click(await screen.findByRole('button', { name: 'Delete auth configuration' }))
    return { user, dialog: await screen.findByRole('alertdialog') }
  }

  it('asks before removing the method', async () => {
    const { dialog } = await openRemove()
    expect(within(dialog).getByText('Remove this authentication method?')).toBeInTheDocument()
    expect(within(dialog).getByText(/will no longer be able to access the gateway/)).toBeInTheDocument()
    expect(gatewaysApi.deleteAuthConfig).not.toHaveBeenCalled()
  })

  it('cancelling keeps the method', async () => {
    const { user, dialog } = await openRemove()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(gatewaysApi.deleteAuthConfig).not.toHaveBeenCalled()
  })

  it('removes the method once confirmed', async () => {
    vi.mocked(gatewaysApi.deleteAuthConfig).mockResolvedValue({} as any)
    const { user, dialog } = await openRemove()
    await user.click(within(dialog).getByRole('button', { name: 'Remove method' }))
    await waitFor(() => expect(gatewaysApi.deleteAuthConfig).toHaveBeenCalledWith('gw-1', 'auth-1'))
  })
})