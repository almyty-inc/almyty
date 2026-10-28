import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AuditStreamsSettings } from '../audit-streams-settings'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }))
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => ({ enabled: true, isLoading: false }) }))

/**
 * Configuring a SIEM target.
 *
 * The backend was complete and unreachable — an organization could not
 * add a target without calling the API by hand. The case worth guarding
 * is the http:// refusal: audit events name who did what, and sending
 * them in the clear is the mistake this form should not let someone make
 * quietly.
 */
describe('audit streaming settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as any).mockResolvedValue({ data: { data: [] } })
    ;(api.post as any).mockResolvedValue({ data: { data: {} } })
    ;(api.patch as any).mockResolvedValue({ data: { data: {} } })
    ;(api.delete as any).mockResolvedValue({ data: {} })
  })

  it('adds a target', async () => {
    render(<AuditStreamsSettings />)

    fireEvent.change(await screen.findByLabelText('Endpoint'), {
      target: { value: 'https://http-intake.logs.datadoghq.com/api/v2/logs' },
    })
    fireEvent.click(screen.getByTestId('add-stream'))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/audit-export/streams', {
        target: 'webhook',
        endpoint: 'https://http-intake.logs.datadoghq.com/api/v2/logs',
      }),
    )
  })

  it('refuses a plaintext endpoint, and says why', async () => {
    render(<AuditStreamsSettings />)

    fireEvent.change(await screen.findByLabelText('Endpoint'), { target: { value: 'http://siem.internal/in' } })

    expect(screen.getByTestId('stream-insecure')).toHaveTextContent(/in the clear/i)
    expect(screen.getByTestId('add-stream')).toBeDisabled()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('lists the targets already configured and can remove one', async () => {
    ;(api.get as any).mockResolvedValue({
      data: { data: [{ id: 's1', target: 'splunk_hec', endpoint: 'https://splunk.example/services/collector' }] },
    })
    render(<AuditStreamsSettings />)

    expect(await screen.findByText('Splunk HEC')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('remove-stream-s1'))
    // Asks first: removing a stream silently stops the export.
    const dialog = await screen.findByRole('alertdialog')
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove stream' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/audit-export/streams/s1'))
  })

  it('explains that no target does not mean no audit log', async () => {
    render(<AuditStreamsSettings />)
    expect(await screen.findByTestId('no-streams')).toHaveTextContent(/still recorded/i)
  })

  it('sends a token only when one was typed', async () => {
    render(<AuditStreamsSettings />)

    fireEvent.change(await screen.findByLabelText('Endpoint'), { target: { value: 'https://siem.example/in' } })
    fireEvent.change(screen.getByLabelText('Token (optional)'), { target: { value: 'hec-token' } })
    fireEvent.click(screen.getByTestId('add-stream'))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/audit-export/streams', {
        target: 'webhook',
        endpoint: 'https://siem.example/in',
        token: 'hec-token',
      }),
    )
  })

  // The backend recorded each target's last delivery and last error, and
  // the page showed neither: a Splunk token gone stale failed silently.
  it("says how each target's deliveries are going, and what it streams", async () => {
    ;(api.get as any).mockResolvedValue({
      data: {
        data: [
          { id: 's1', target: 'splunk_hec', endpoint: 'https://splunk.example/hec', lastError: 'HTTP 403', lastDeliveredAt: null, actionFilter: ['approval_decided'] },
          { id: 's2', target: 'webhook', endpoint: 'https://hooks.example/in', lastError: null, lastDeliveredAt: new Date().toISOString(), actionFilter: null, enabled: false },
        ],
      },
    })
    render(<AuditStreamsSettings />)

    expect(await screen.findByTestId('stream-status-s1')).toHaveTextContent('Last delivery failed: HTTP 403')
    expect(screen.getByTestId('stream-filter-s1')).toHaveTextContent('Only: approval_decided')
    expect(screen.getByTestId('stream-status-s2')).toHaveTextContent(/^Delivered /)
    expect(screen.getByTestId('stream-filter-s2')).toHaveTextContent('Every action')
    expect(screen.getByText('Off')).toBeInTheDocument()
  })

  it('changes a target in place: its actions, keeping its token', async () => {
    ;(api.get as any).mockResolvedValue({
      data: { data: [{ id: 's1', target: 'splunk_hec', endpoint: 'https://splunk.example/hec', hasToken: true, actionFilter: null, enabled: true }] },
    })
    render(<AuditStreamsSettings />)

    fireEvent.click(await screen.findByTestId('edit-stream-s1'))
    expect(screen.getByLabelText('Endpoint')).toHaveValue('https://splunk.example/hec')
    expect(screen.getByLabelText('Token (optional)')).toHaveAttribute('placeholder', 'Leave blank to keep the current token')
    fireEvent.change(screen.getByLabelText('Only these actions (optional)'), { target: { value: 'approval_decided, sso_login' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/audit-export/streams/s1', {
        endpoint: 'https://splunk.example/hec',
        actionFilter: ['approval_decided', 'sso_login'],
        enabled: true,
      }),
    )
    expect(api.post).not.toHaveBeenCalled()
  })

  it('adds a target that streams only some actions', async () => {
    render(<AuditStreamsSettings />)

    fireEvent.change(await screen.findByLabelText('Endpoint'), { target: { value: 'https://siem.example/in' } })
    fireEvent.change(screen.getByLabelText('Only these actions (optional)'), { target: { value: 'sso_login' } })
    fireEvent.click(screen.getByTestId('add-stream'))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/audit-export/streams', {
        target: 'webhook',
        endpoint: 'https://siem.example/in',
        actionFilter: ['sso_login'],
      }),
    )
  })
})
