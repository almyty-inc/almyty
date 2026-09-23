import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AuditStreamsSettings } from '../audit-streams-settings'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))
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
})
