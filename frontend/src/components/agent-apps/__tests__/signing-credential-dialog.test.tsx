import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { SigningCredentialDialog } from '../signing-credential-dialog'
import { credentialsApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, credentialsApi: { create: vi.fn(), getAll: vi.fn() } }
})

const certificate = () =>
  new File([new Uint8Array([0x30, 0x82, 0x01])], 'developer-id.p12', {
    type: 'application/x-pkcs12',
  })

async function fillCommon(name = 'Developer ID', password = 'hunter2') {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Certificate password'), {
    target: { value: password },
  })
  fireEvent.change(screen.getByLabelText(/Certificate \(/), {
    target: { files: [certificate()] },
  })
}

async function fillApple() {
  fireEvent.change(screen.getByLabelText('App Store Connect key id'), {
    target: { value: 'ABCD1234EF' },
  })
  fireEvent.change(screen.getByLabelText('Issuer id'), { target: { value: 'iss-1' } })
  fireEvent.change(screen.getByLabelText(/Private key/), {
    target: { value: '-----BEGIN PRIVATE KEY-----' },
  })
}

describe('SigningCredentialDialog', () => {
  const onCreated = vi.fn()
  const onOpenChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(credentialsApi.create as any).mockResolvedValue({ data: { id: 'cred-9' } })
  })

  const renderApple = () =>
    render(
      <SigningCredentialDialog
        open
        onOpenChange={onOpenChange}
        kind="apple"
        onCreated={onCreated}
      />,
    )

  const renderWindows = () =>
    render(
      <SigningCredentialDialog
        open
        onOpenChange={onOpenChange}
        kind="authenticode"
        onCreated={onCreated}
      />,
    )

  it('will not store a certificate with no password', async () => {
    renderApple()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: /Store certificate/ })).toBeDisabled()
  })

  it('will not store an Apple identity without notarisation keys', async () => {
    // Signed but unnotarised still warns on download, so a credential
    // missing these produces a build that looks signed and is not.
    renderApple()
    await fillCommon()
    expect(screen.getByRole('button', { name: /Store certificate/ })).toBeDisabled()
  })

  it('does not ask Windows for notarisation keys', async () => {
    renderWindows()
    expect(screen.queryByLabelText('App Store Connect key id')).toBeNull()

    await fillCommon()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Store certificate/ })).toBeEnabled(),
    )
  })

  it('stores the certificate as base64 under the code-signing type', async () => {
    renderApple()
    await fillCommon()
    await fillApple()

    fireEvent.click(screen.getByRole('button', { name: /Store certificate/ }))

    await waitFor(() => expect(credentialsApi.create).toHaveBeenCalled())
    const payload = (credentialsApi.create as any).mock.calls[0][0]
    expect(payload.type).toBe('code_signing')
    expect(payload.config.certificatePassword).toBe('hunter2')
    // Base64 of the file bytes, not a data: URL and not the File object.
    expect(payload.config.certificate).toBe('MIIB')
    expect(payload.config.appleApiKeyId).toBe('ABCD1234EF')
  })

  it('hands the new credential back so it can be selected at once', async () => {
    renderApple()
    await fillCommon()
    await fillApple()
    fireEvent.click(screen.getByRole('button', { name: /Store certificate/ }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('cred-9'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('refuses a file far too large to be a certificate', async () => {
    // A .p12 is kilobytes. Anything else is a mistake, and base64 of it
    // would go straight into a JSON body.
    renderWindows()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('Certificate password'), {
      target: { value: 'pw' },
    })
    const huge = new File([new Uint8Array(600 * 1024)], 'huge.p12')
    fireEvent.change(screen.getByLabelText(/Certificate \(/), { target: { files: [huge] } })

    fireEvent.click(screen.getByRole('button', { name: /Store certificate/ }))

    await waitFor(() => expect(credentialsApi.create).not.toHaveBeenCalled())
  })

  it('leaves the dialog open when the store fails', async () => {
    ;(credentialsApi.create as any).mockRejectedValue(new Error('nope'))
    renderWindows()
    await fillCommon()

    fireEvent.click(screen.getByRole('button', { name: /Store certificate/ }))

    await waitFor(() => expect(credentialsApi.create).toHaveBeenCalled())
    expect(onCreated).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('says the certificate is never shown again', async () => {
    renderApple()
    expect(screen.getByText(/never shown again/i)).toBeInTheDocument()
  })
})
