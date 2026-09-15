import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { KmsSettings } from '../kms-settings'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }))
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => ({ enabled: true, isLoading: false }) }))

/**
 * Attaching a customer-managed key.
 *
 * The backend was complete and unreachable. Two things this surface must
 * not get wrong: it must never imply key material passes through it, and
 * it must say plainly that switching the key off does not re-encrypt what
 * is already stored — someone who believes otherwise thinks their data
 * moved when it did not.
 */
const config = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  cmkArn: null,
  awsRegion: null,
  provisioned: false,
  updatedAt: null,
  ...over,
})

describe('customer-managed key settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as any).mockResolvedValue({ data: { data: config() } })
    ;(api.put as any).mockResolvedValue({ data: { data: config({ provisioned: true, enabled: true }) } })
  })

  it('says secrets use the platform key until one is attached', async () => {
    render(<KmsSettings />)
    expect(await screen.findByTestId('kms-status')).toHaveTextContent(/platform key/i)
  })

  it('attaches a key by reference, never by material', async () => {
    render(<KmsSettings />)

    fireEvent.change(await screen.findByLabelText('CMK ARN'), {
      target: { value: 'arn:aws:kms:eu-central-1:111122223333:key/abc' },
    })
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-central-1' } })
    fireEvent.click(screen.getByTestId('attach-cmk'))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/kms', {
        cmkArn: 'arn:aws:kms:eu-central-1:111122223333:key/abc',
        awsRegion: 'eu-central-1',
        enabled: true,
      }),
    )
    // The page says so too, because "where does my key go" is the first
    // question anyone asks of this screen.
    expect(screen.getByText(/never leaves your account/i)).toBeInTheDocument()
  })

  it('catches something that is not an ARN before it becomes a failed wrap', async () => {
    render(<KmsSettings />)

    fireEvent.change(await screen.findByLabelText('CMK ARN'), { target: { value: 'my-key-id' } })

    expect(screen.getByTestId('kms-arn-invalid')).toBeInTheDocument()
    expect(screen.getByTestId('attach-cmk')).toBeDisabled()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('says what switching the key off does NOT do', async () => {
    ;(api.get as any).mockResolvedValue({
      data: { data: config({ provisioned: true, enabled: true, cmkArn: 'arn:aws:kms:eu-central-1:1:key/a' }) },
    })
    render(<KmsSettings />)

    expect(await screen.findByText(/does not re-encrypt what is already/i)).toBeInTheDocument()
  })

  it('switches the key off without detaching it', async () => {
    ;(api.get as any).mockResolvedValue({
      data: { data: config({ provisioned: true, enabled: true, cmkArn: 'arn:aws:kms:eu-central-1:1:key/a' }) },
    })
    render(<KmsSettings />)

    fireEvent.click(await screen.findByLabelText('Use this key'))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/kms/enabled', { enabled: false }))
  })
})
