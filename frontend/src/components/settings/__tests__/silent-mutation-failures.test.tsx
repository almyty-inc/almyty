import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

// Removing a stream asks first; this answers the confirmation.
const confirmRemoval = async () =>
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove stream' }))

import { render } from '../../../test/setup'
import { KmsSettings } from '../kms-settings'
import { AuditStreamsSettings } from '../audit-streams-settings'
import { api } from '@/lib/api'

// Each of these mutations had neither an onError nor an isError branch,
// while its sibling in the same card had one. A refused call stopped the
// spinner, reverted the control and said nothing -- which reads as a
// dead button on two settings that decide where secrets are wrapped and
// where audit events are sent.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/hooks/use-entitlement', () => ({
  useEntitlement: () => ({ enabled: true, isLoading: false }),
}))

describe('kms enable toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as any).mockResolvedValue({
      data: {
        data: {
          enabled: true,
          cmkArn: 'arn:aws:kms:eu-central-1:111122223333:key/abc',
          awsRegion: 'eu-central-1',
          provisioned: true,
          updatedAt: null,
        },
      },
    })
  })

  it('says why a refused toggle did not take', async () => {
    ;(api.put as any).mockRejectedValue({
      response: {
        status: 409,
        data: { error: { code: 'KMS_KEY_UNREACHABLE', message: 'almyty cannot reach that key.' } },
      },
    })

    render(<KmsSettings />)

    fireEvent.click(await screen.findByRole('switch'))

    await waitFor(() =>
      expect(screen.getByTestId('kms-enabled-error')).toHaveTextContent(
        'almyty cannot reach that key.',
      ),
    )
  })

  it('says nothing when the toggle succeeds', async () => {
    ;(api.put as any).mockResolvedValue({
      data: { data: { enabled: false, cmkArn: 'arn:x', awsRegion: 'eu', provisioned: true, updatedAt: null } },
    })

    render(<KmsSettings />)
    fireEvent.click(await screen.findByRole('switch'))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(screen.queryByTestId('kms-enabled-error')).not.toBeInTheDocument()
  })
})

describe('audit stream removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as any).mockResolvedValue({
      data: { data: [{ id: 's1', target: 'splunk', endpoint: 'https://splunk.example/x' }] },
    })
  })

  it('says why a refused removal left the target in place', async () => {
    ;(api.delete as any).mockRejectedValue({
      response: {
        status: 403,
        data: { error: { code: 'ACCESS_DENIED', message: 'Only an owner can remove a stream.' } },
      },
    })

    render(<AuditStreamsSettings />)

    fireEvent.click(await screen.findByTestId('remove-stream-s1'))
    await confirmRemoval()

    await waitFor(() =>
      expect(screen.getByTestId('remove-stream-error')).toHaveTextContent(
        'Only an owner can remove a stream.',
      ),
    )
    // The row is still there, which is now explained rather than odd.
    expect(screen.getByTestId('audit-streams')).toBeInTheDocument()
  })

  it('says nothing when the removal succeeds', async () => {
    ;(api.delete as any).mockResolvedValue({ data: {} })

    render(<AuditStreamsSettings />)
    fireEvent.click(await screen.findByTestId('remove-stream-s1'))
    await confirmRemoval()

    await waitFor(() => expect(api.delete).toHaveBeenCalled())
    expect(screen.queryByTestId('remove-stream-error')).not.toBeInTheDocument()
  })
})
