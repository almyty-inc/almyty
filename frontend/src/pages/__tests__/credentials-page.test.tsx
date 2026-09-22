import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../test/setup'
import { CredentialsPage } from '../credentials'
import { credentialsApi, accessKeysApi, gatewaysApi, agentsApi } from '../../lib/api'

// Deleting a vault secret is irreversible and used to fire straight off a
// DropdownMenuItem that sits one row away from Copy -- a misclick destroyed
// a credential, and a rejected delete said nothing at all. These tests pin
// both halves of the fix: the confirm step, and the error toast.

vi.mock('../../lib/api', () => ({
  credentialsApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  accessKeysApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
  },
  gatewaysApi: { getAll: vi.fn() },
  agentsApi: { getAll: vi.fn() },
  organizationsApi: { getTeams: vi.fn() },
}))

const notifySuccess = vi.fn()
const notifyError = vi.fn()
vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: notifySuccess,
    error: notifyError,
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'org-test', name: 'Test Org' },
  }),
}))

// The page picks its tab off the pathname, so the route has to be steerable
// per test: the vault lives at /credentials, access keys one level down.
const route = vi.hoisted(() => ({ pathname: '/credentials' }))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useLocation: () => ({ pathname: route.pathname, search: '', hash: '', state: null }),
  }
})

const CREDENTIAL = {
  id: 'cred-1',
  name: 'Stripe API Key',
  type: 'api_key',
  description: 'Live key',
  isActive: true,
  visibility: 'org',
  teamId: null,
  usedBy: [],
  createdAt: '2026-01-05T10:00:00.000Z',
}

/** Open the row's actions menu and click Delete. */
async function clickDeleteInRowMenu() {
  fireEvent.pointerDown(
    await screen.findByRole('button', { name: /Open actions menu/i }),
  )
  fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/i }))
}

describe('CredentialsPage vault delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.pathname = '/credentials'
    // Radix menus need these in jsdom.
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
      Element.prototype.setPointerCapture = vi.fn()
      Element.prototype.releasePointerCapture = vi.fn()
    }
    ;(credentialsApi.getAll as any).mockResolvedValue([CREDENTIAL])
  })

  it('asks for confirmation naming the credential instead of deleting on the menu click', async () => {
    render(<CredentialsPage />)

    await screen.findByText('Stripe API Key')
    await clickDeleteInRowMenu()

    // The confirm has to name the secret -- "Are you sure?" over a vault row
    // tells you nothing about which one you are about to destroy.
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete credential?')
    expect(dialog).toHaveTextContent('Stripe API Key')

    // Nothing has been deleted yet.
    expect(credentialsApi.delete).not.toHaveBeenCalled()
  })

  it('deletes only after the confirm action is pressed', async () => {
    ;(credentialsApi.delete as any).mockResolvedValue({})
    render(<CredentialsPage />)

    await screen.findByText('Stripe API Key')
    await clickDeleteInRowMenu()

    fireEvent.click(
      await screen.findByRole('button', { name: /Delete Credential/i }),
    )

    await waitFor(() => {
      expect(credentialsApi.delete).toHaveBeenCalledWith('cred-1')
    })
  })

  it('cancelling leaves the credential alone', async () => {
    render(<CredentialsPage />)

    await screen.findByText('Stripe API Key')
    await clickDeleteInRowMenu()

    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/i }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(credentialsApi.delete).not.toHaveBeenCalled()
  })

  it('surfaces a failed delete instead of silently leaving the row in place', async () => {
    ;(credentialsApi.delete as any).mockRejectedValue(
      new Error('Credential is in use by 2 gateways'),
    )
    render(<CredentialsPage />)

    await screen.findByText('Stripe API Key')
    await clickDeleteInRowMenu()
    fireEvent.click(
      await screen.findByRole('button', { name: /Delete Credential/i }),
    )

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Failed to delete credential',
        expect.stringContaining('Credential is in use'),
      )
    })
  })
})

describe('CredentialsPage dates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.pathname = '/credentials/access-keys'
    ;(credentialsApi.getAll as any).mockResolvedValue([])
    ;(gatewaysApi.getAll as any).mockResolvedValue([])
    ;(agentsApi.getAll as any).mockResolvedValue([])
    ;(accessKeysApi.getAll as any).mockResolvedValue([
      {
        id: 'key-1',
        name: 'Production Key',
        keyPrefix: 'alm_abc',
        scopes: ['read'],
        lastUsedAt: null,
        createdAt: '2026-01-05T10:00:00.000Z',
      },
    ])
  })

  it('renders absolute dates, matching every other page', async () => {
    render(<CredentialsPage />)

    // A local formatDate used to shadow the shared helper here and print
    // relative time, so the same column read "3h ago" on Credentials and
    // "Jan 5, 2026" on Organizations.
    await waitFor(() => {
      expect(screen.getByText('Jan 5, 2026')).toBeInTheDocument()
    })
    // lastUsedAt is null, which must still read as "Never" rather than
    // an Invalid Date.
    expect(screen.getByText('Never')).toBeInTheDocument()
  })
})
