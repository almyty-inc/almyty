import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { KmsSettings } from '../kms-settings'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))
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

// Rotation now asks first; this answers the confirmation.
const confirmRotation = async () =>
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rotate key' }))

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

  /**
   * Rotation has to be reachable, and it must not be the attach call.
   *
   * Attaching twice minted a second data key over the first, which made
   * every secret sealed under the old one unreadable — silently. The
   * button read "Replace key" while calling attach, so the UI offered
   * exactly the destructive operation. The server refuses a re-attach
   * now; these pin that the UI asks for the right thing rather than
   * relying on that refusal.
   */
  describe('rotating an attached key', () => {
    beforeEach(() => {
      ;(api.get as any).mockResolvedValue({
        data: { data: config({ provisioned: true, enabled: true, cmkArn: 'arn:aws:kms:eu-central-1:1:key/a' }) },
      })
      ;(api.post as any).mockResolvedValue({
        data: { data: config({ provisioned: true, enabled: true, cmkArn: 'arn:aws:kms:eu-central-1:1:key/b' }) },
      })
    })

    it('offers Rotate, not Replace, once a key is attached', async () => {
      render(<KmsSettings />)
      expect(await screen.findByTestId('rotate-cmk')).toHaveTextContent(/rotate key/i)
      expect(screen.queryByTestId('attach-cmk')).toBeNull()
      expect(screen.queryByText(/replace key/i)).toBeNull()
    })

    it('rotates through the rotate endpoint and never through attach', async () => {
      render(<KmsSettings />)
      fireEvent.click(await screen.findByTestId('rotate-cmk'))
      expect(await screen.findByRole('alertdialog')).toHaveTextContent('Rotate the encryption key?')
      expect(api.post).not.toHaveBeenCalled()
      await confirmRotation()
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/kms/rotate', expect.anything()))
      // The destructive call. It must not happen from this screen.
      expect(api.put).not.toHaveBeenCalledWith('/kms', expect.anything())
    })

    it('rotates under the key the form is showing', async () => {
      // The form prefills from the saved config, so the ordinary rotation
      // is "same CMK, fresh data key" and sends the ARN already on screen.
      // Clearing the field is what asks the server to keep its configured
      // one, and an empty string must not reach it as an ARN.
      render(<KmsSettings />)
      fireEvent.click(await screen.findByTestId('rotate-cmk'))
      await confirmRotation()
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/kms/rotate', {
          cmkArn: 'arn:aws:kms:eu-central-1:1:key/a',
          awsRegion: undefined,
        }),
      )
    })

    it('sends no ARN at all when the field is cleared', async () => {
      render(<KmsSettings />)
      // Wait for the button, not the input: the ARN field renders before
      // the config query settles, so awaiting it proves nothing about
      // whether the provisioned branch is on screen yet.
      const button = await screen.findByTestId('rotate-cmk')
      fireEvent.change(screen.getByLabelText('CMK ARN'), { target: { value: '' } })
      fireEvent.click(button)
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/kms/rotate', { cmkArn: undefined, awsRegion: undefined }),
      await confirmRotation()
      )
    })
    it('says older secrets stay readable, because that is the whole point', async () => {
      render(<KmsSettings />)
      await screen.findByTestId('rotate-cmk')
      expect(screen.getByText(/stay\s+readable/i)).toBeInTheDocument()
    })

    it('surfaces a refused rotation', async () => {
      ;(api.post as any).mockRejectedValue({
        response: { data: { error: { message: 'That key could not be used to wrap a new data key.' } } },
      })
      render(<KmsSettings />)
      fireEvent.click(await screen.findByTestId('rotate-cmk'))
      await confirmRotation()
      expect(await screen.findByTestId('kms-error')).toHaveTextContent(/could not be used to wrap/i)
    })
  })
})
