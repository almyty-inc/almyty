import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { ChannelInstallationsPanel } from '../channel-installations-panel'
import { gatewaysApi } from '@/lib/api'
import type { Gateway } from '@/types'

const copyMock = vi.fn()

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getInstallations: vi.fn(),
    revokeInstallation: vi.fn(),
  },
  getApiBaseUrl: () => 'https://api.example.com',
}))

vi.mock('@/lib/clipboard', () => ({
  useCopy: () => copyMock,
}))

const makeGateway = (overrides: Partial<Gateway> = {}): Gateway =>
  ({
    id: 'gw-1',
    name: 'Support Bot',
    type: 'slack',
    kind: 'agent',
    status: 'active',
    endpoint: '/support-bot',
    configuration: { client_id: '123.456', client_secret: 'encrypted:gcm:aa:bb:cc' },
    ...overrides,
  }) as unknown as Gateway

const installation = (overrides: Record<string, any> = {}) => ({
  id: 'inst-1',
  externalTenantId: 'T777',
  status: 'active',
  metadata: { teamName: 'Customer Co' },
  installedAt: '2026-06-01T10:00:00Z',
  ...overrides,
})

describe('ChannelInstallationsPanel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders nothing for a non-slack gateway', () => {
    renderWithProviders(
      <ChannelInstallationsPanel gateway={makeGateway({ type: 'telegram' } as any)} />,
    )
    expect(screen.queryByTestId('channel-installations-panel')).not.toBeInTheDocument()
    expect(gatewaysApi.getInstallations).not.toHaveBeenCalled()
  })

  it('renders nothing for a slack gateway without a configured client_id', () => {
    renderWithProviders(
      <ChannelInstallationsPanel
        gateway={makeGateway({ configuration: { botToken: 'xoxb' } } as any)}
      />,
    )
    expect(screen.queryByTestId('channel-installations-panel')).not.toBeInTheDocument()
  })

  it('shows the copyable install URL for a slack gateway with a client_id', async () => {
    ;(gatewaysApi.getInstallations as any).mockResolvedValue([])
    renderWithProviders(<ChannelInstallationsPanel gateway={makeGateway()} />)

    expect(await screen.findByTestId('slack-install-url')).toHaveTextContent(
      'https://api.example.com/gateways/gw-1/install/slack',
    )

    fireEvent.click(screen.getByRole('button', { name: /Copy install URL/ }))
    expect(copyMock).toHaveBeenCalledWith(
      'https://api.example.com/gateways/gw-1/install/slack',
      'Install URL',
    )
  })

  it('shows an empty state when no workspace has installed yet', async () => {
    ;(gatewaysApi.getInstallations as any).mockResolvedValue([])
    renderWithProviders(<ChannelInstallationsPanel gateway={makeGateway()} />)

    expect(await screen.findByTestId('no-installations')).toBeInTheDocument()
  })

  it('lists installations with team name, install date, and status', async () => {
    ;(gatewaysApi.getInstallations as any).mockResolvedValue([
      installation(),
      installation({
        id: 'inst-2',
        externalTenantId: 'T888',
        status: 'revoked',
        metadata: { teamName: 'Old Co' },
      }),
    ])
    renderWithProviders(<ChannelInstallationsPanel gateway={makeGateway()} />)

    const rows = await screen.findAllByTestId('installation-row')
    expect(rows).toHaveLength(2)
    expect(screen.getByText('Customer Co')).toBeInTheDocument()
    expect(screen.getByText('Old Co')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('revoked')).toBeInTheDocument()
    // Revoked installations have no revoke button; active ones do.
    expect(screen.getAllByRole('button', { name: /Revoke/ })).toHaveLength(1)
  })

  it('falls back to the tenant id when the team name is missing', async () => {
    ;(gatewaysApi.getInstallations as any).mockResolvedValue([installation({ metadata: null })])
    renderWithProviders(<ChannelInstallationsPanel gateway={makeGateway()} />)

    expect(await screen.findByText('T777')).toBeInTheDocument()
  })

  it('revokes an installation and refetches the list', async () => {
    ;(gatewaysApi.getInstallations as any)
      .mockResolvedValueOnce([installation()])
      .mockResolvedValueOnce([installation({ status: 'revoked' })])
    ;(gatewaysApi.revokeInstallation as any).mockResolvedValue({ id: 'inst-1', status: 'revoked' })

    renderWithProviders(<ChannelInstallationsPanel gateway={makeGateway()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Revoke/ }))

    await waitFor(() => {
      expect(gatewaysApi.revokeInstallation).toHaveBeenCalledWith('gw-1', 'inst-1')
    })
    await waitFor(() => {
      expect(screen.getByText('revoked')).toBeInTheDocument()
    })
  })
})
