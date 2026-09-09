import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ExpiryPanel } from '../expiry-panel'
import { connectionsAuditExportApi, connectionsExpiryApi, connectionsRotationApi } from '../../../lib/connections-governance-api'
import { connectionsApi } from '../../../lib/connections-api'

vi.mock('../../../lib/connections-governance-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-governance-api')>('../../../lib/connections-governance-api')
  return {
    ...actual,
    connectionsExpiryApi: { list: vi.fn(), enforce: vi.fn() },
    connectionsRotationApi: { candidates: vi.fn(), rotateDue: vi.fn() },
    connectionsAuditExportApi: { download: vi.fn() },
  }
})

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return { ...actual, connectionsApi: { ...actual.connectionsApi, list: vi.fn() } }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

describe('ExpiryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectionsApi.list).mockResolvedValue([
      { id: 'c1', name: 'OpenAI prod', connectorKey: 'openai', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '2026-06-01T00:00:00.000Z' },
    ])
    vi.mocked(connectionsExpiryApi.list).mockResolvedValue({
      warn: [{ connectionId: 'c1', connectorKey: 'openai', ownerUserId: null, ageDays: 85, maxAgeDays: 90, expiresOn: '2099-01-01T00:00:00.000Z', policyId: 'p1' }],
      expire: [{ connectionId: 'c2', connectorKey: 'slack', ownerUserId: 'u1', ageDays: 120, maxAgeDays: 90, expiresOn: '2026-08-01T00:00:00.000Z', policyId: 'p1' }],
      enforce: true,
    })
    vi.mocked(connectionsRotationApi.candidates).mockResolvedValue({
      due: [{ connectionId: 'c1', connectorKey: 'openai', ownerUserId: null, ageDays: 95, everyDays: 90, policyId: 'p2' }],
      manual: [{ connectionId: 'c2', connectorKey: 'slack', ownerUserId: 'u1', ageDays: 200, everyDays: 90, policyId: 'p2' }],
    })
  })

  it('lists expiring and due connections by name, with owner and status', async () => {
    render(<ExpiryPanel />)
    const warn = await screen.findByTestId('expiring-row-c1')
    await waitFor(() => expect(warn).toHaveTextContent('OpenAI prod'))
    expect(warn).toHaveAttribute('data-status', 'warn')
    expect(warn).toHaveTextContent('85 of 90 days')
    expect(warn).toHaveTextContent('org')
    const expired = screen.getByTestId('expiring-row-c2')
    expect(expired).toHaveAttribute('data-status', 'expire')
    expect(expired).toHaveTextContent('slack connection')
    expect(expired).toHaveTextContent('personal')
    expect(expired).toHaveTextContent('past')
    expect(screen.getByText(/grants are revoked on expiry/)).toBeInTheDocument()

    expect(screen.getByTestId('rotation-row-c1')).toHaveTextContent('provider API')
    expect(screen.getByTestId('rotation-row-c2')).toHaveTextContent('manual')
  })

  it('runs the rotation now and reports the outcome', async () => {
    vi.mocked(connectionsRotationApi.rotateDue).mockResolvedValue({ organizationId: 'o1', rotated: 1, failed: 0, manual: 1 })
    render(<ExpiryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate due now' }))
    await waitFor(() => expect(connectionsRotationApi.rotateDue).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Rotation run finished', '1 rotated, 1 manual'))
  })

  it('warns when a rotation failed', async () => {
    vi.mocked(connectionsRotationApi.rotateDue).mockResolvedValue({ organizationId: 'o1', rotated: 0, failed: 2, manual: 0 })
    render(<ExpiryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate due now' }))
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('Rotation run finished', '0 rotated, 2 failed'))
  })

  it('runs the expiry enforcement now', async () => {
    vi.mocked(connectionsExpiryApi.enforce).mockResolvedValue({ organizationId: 'o1', warned: 1, expired: 1, revokedGrants: 3, enforce: true })
    render(<ExpiryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Run expiry now' }))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Expiry run finished', '1 warned, 1 expired, 3 grants revoked'))
  })

  it('downloads the audit export as JSON and CSV', async () => {
    vi.mocked(connectionsAuditExportApi.download).mockResolvedValue({ filename: 'connections-audit.json', count: 42, retentionDays: 'unlimited' })
    render(<ExpiryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Export JSON' }))
    await waitFor(() => expect(connectionsAuditExportApi.download).toHaveBeenCalledWith('json'))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Export ready', '42 events, no retention window, connections-audit.json'))

    vi.mocked(connectionsAuditExportApi.download).mockRejectedValueOnce(new Error('402'))
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(connectionsAuditExportApi.download).toHaveBeenLastCalledWith('csv'))
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Export failed', '402'))
  })

  it('shows empty copy when nothing is due', async () => {
    vi.mocked(connectionsExpiryApi.list).mockResolvedValue({ warn: [], expire: [], enforce: false })
    vi.mocked(connectionsRotationApi.candidates).mockResolvedValue({ due: [], manual: [] })
    render(<ExpiryPanel />)
    expect(await screen.findByTestId('expiring-empty')).toBeInTheDocument()
    expect(await screen.findByTestId('rotation-empty')).toBeInTheDocument()
  })
})
