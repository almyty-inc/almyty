import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
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
