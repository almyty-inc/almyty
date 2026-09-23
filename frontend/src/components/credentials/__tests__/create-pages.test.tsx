import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '../../../test/render-at-route'
import { CredentialNewPage, AccessKeyNewPage } from '../../../pages/credential-new'
import { credentialsApi, accessKeysApi, gatewaysApi, agentsApi } from '../../../lib/api'

// These pages navigate on save; they need the real router.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('../../../lib/api', () => ({
  credentialsApi: { create: vi.fn(), getAll: vi.fn() },
  accessKeysApi: { create: vi.fn(), getAll: vi.fn() },
  gatewaysApi: { getAll: vi.fn() },
  agentsApi: { getAll: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture ??= vi.fn().mockReturnValue(false) as any
  Element.prototype.setPointerCapture ??= vi.fn() as any
  Element.prototype.releasePointerCapture ??= vi.fn() as any
  Element.prototype.scrollIntoView ??= vi.fn() as any
})

describe('/credentials/new', () => {
  it('renders as a page with one primary action', () => {
    renderAtRoute(<CredentialNewPage />, { path: '/credentials/new' })
    expect(screen.getByRole('heading', { name: 'Add credential' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create credential' })).toHaveAttribute('type', 'submit')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // A secret field must not be a login form to a password manager.
    expect(screen.getByLabelText(/API key/)).toHaveAttribute('data-1p-ignore', 'true')
  })

  it('posts the credential in the DTO shape and returns to the vault', async () => {
    vi.mocked(credentialsApi.create).mockResolvedValue({ id: 'cred-1' } as any)
    renderAtRoute(<CredentialNewPage />, { path: '/credentials/new', paths: ['/credentials'] })

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Stripe' } })
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk_live_1' } })
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Live key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create credential' }))

    await waitFor(() => expect(credentialsApi.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(credentialsApi.create).mock.calls[0][0]).toEqual({
      name: 'Stripe',
      type: 'api_key',
      description: 'Live key',
      config: { value: 'sk_live_1' },
      visibility: 'org',
      teamId: null,
    })
    expect(await screen.findByText('at /credentials')).toBeInTheDocument()
    expect(notify.success).toHaveBeenCalledWith('Credential created', expect.stringContaining('Stripe'))
  })

  it('marks the missing field and focuses it instead of posting', async () => {
    renderAtRoute(<CredentialNewPage />, { path: '/credentials/new' })
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Stripe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create credential' }))

    expect(await screen.findByText('Value is required')).toBeInTheDocument()
    const value = screen.getByLabelText(/API key/)
    expect(value).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(document.activeElement).toBe(value))
    expect(credentialsApi.create).not.toHaveBeenCalled()
  })

  it('stays on the page when the server refuses', async () => {
    vi.mocked(credentialsApi.create).mockRejectedValue(new Error('Name taken'))
    renderAtRoute(<CredentialNewPage />, { path: '/credentials/new', paths: ['/credentials'] })
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Stripe' } })
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create credential' }))
    await waitFor(() => expect(notify.error).toHaveBeenCalled())
    expect(screen.getByRole('heading', { name: 'Add credential' })).toBeInTheDocument()
  })
})

describe('/credentials/access-keys/new', () => {
  beforeEach(() => {
    vi.mocked(gatewaysApi.getAll).mockResolvedValue([{ id: 'gw-1', name: 'Weather gateway' }] as any)
    vi.mocked(agentsApi.getAll).mockResolvedValue([] as any)
  })

  it('says what is missing and does not post', async () => {
    renderAtRoute(<AccessKeyNewPage />, { path: '/credentials/access-keys/new' })
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    expect(await screen.findByText('Give the key a name')).toBeInTheDocument()
    expect(screen.getByText('Choose the gateway this key is for')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Name/)))
    expect(accessKeysApi.create).not.toHaveBeenCalled()
  })

  it('generates the key, shows it once with a copy button, and Done returns to the list', async () => {
    const user = userEvent.setup()
    vi.mocked(accessKeysApi.create).mockResolvedValue({ key: 'alm_secret_123' } as any)
    renderAtRoute(<AccessKeyNewPage />, { path: '/credentials/access-keys/new', paths: ['/credentials/access-keys'] })

    await user.type(screen.getByLabelText(/^Name/), 'CI key')
    await user.click(screen.getByRole('combobox', { name: /^Gateway/ }))
    await user.click(await screen.findByRole('option', { name: 'Weather gateway' }))
    await user.click(screen.getByRole('button', { name: /execute/ }))
    await user.click(screen.getByRole('button', { name: 'Generate key' }))

    await waitFor(() => expect(accessKeysApi.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(accessKeysApi.create).mock.calls[0][0]).toEqual({ name: 'CI key', scopes: ['read', 'execute'], gatewayId: 'gw-1' })

    expect(await screen.findByRole('heading', { name: 'Key generated' })).toBeInTheDocument()
    expect(screen.getByTestId('copy-field-value')).toHaveTextContent('alm_secret_123')
    expect(screen.getByRole('button', { name: 'Copy access key' })).toBeInTheDocument()
    expect(screen.getByText(/You won't see this key again/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('at /credentials/access-keys')).toBeInTheDocument()
  })
})
