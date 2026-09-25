/**
 * The API page's one Key card (it replaced "Authentication" and
 * "Upstream credentials", which were the same secret twice). It says how
 * the key is sent and where it comes from; "Replace key" opens the paste
 * form in place, "Connect an account" is the alternative, OAuth 2.0 specs
 * sign in and come back here, and a half-typed key asks before leaving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { ApiKeyCard } from '../key-card'
import { apisApi, credentialsApi } from '@/lib/api'
import type { ApiKeyView } from '@/types/api-connect'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apisApi: { getKey: vi.fn(), setKey: vi.fn(), removeKey: vi.fn() },
  credentialsApi: { oauth2Authorize: vi.fn(), oauth2ClientCredentials: vi.fn() },
}))
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

const view = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  type: 'api_key',
  headerName: 'X-Pets-Key',
  location: 'header',
  oauth2: null,
  source: null,
  credential: null,
  connection: null,
  ...over,
})

const at = () => renderAtRoute(<ApiKeyCard apiId="api-1" apiName="Petstore" />, { path: '/apis/api-1', paths: ['/elsewhere'] })

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('the Key card', () => {
  it('says how the key is sent and that there is none yet, and adds one by pasting it', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view())
    vi.mocked(apisApi.setKey).mockResolvedValue(view({ source: 'key', credential: { id: 'c1', name: 'k', type: 'api_key', lastUsedAt: null, updatedAt: null } }))
    const user = userEvent.setup()
    at()

    const summary = await screen.findByTestId('api-key-summary')
    expect(summary).toHaveTextContent('Sent in the X-Pets-Key header')
    expect(summary).toHaveTextContent('No key yet')
    // One card, not the two it replaced.
    expect(screen.queryByText('Upstream credentials')).not.toBeInTheDocument()
    expect(screen.queryByText('Authentication')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add a key' }))
    const key = screen.getByLabelText('Paste your key')
    // A secret: masked, and password managers keep out.
    expect(key).toHaveAttribute('type', 'password')
    expect(key).toHaveAttribute('data-1p-ignore', 'true')
    await user.type(key, 'pk-live-1')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    await waitFor(() =>
      expect(apisApi.setKey).toHaveBeenCalledWith('api-1', { type: 'api_key', key: 'pk-live-1', headerName: 'X-Pets-Key', location: 'header' }),
    )
    expect(await screen.findByTestId('api-key-summary')).toHaveTextContent('A pasted key, stored encrypted')
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument()
  })

  it('changes the header on the way', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view({ source: 'key' }))
    vi.mocked(apisApi.setKey).mockResolvedValue(view({ source: 'key', headerName: 'Authorization-Token' }))
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: 'Replace key' }))
    await user.click(screen.getByRole('button', { name: 'Change' }))
    const header = screen.getByLabelText('Header')
    await user.clear(header)
    await user.type(header, 'Authorization-Token')
    await user.type(screen.getByLabelText('Paste your key'), 'pk-2')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() =>
      expect(apisApi.setKey).toHaveBeenCalledWith('api-1', { type: 'api_key', key: 'pk-2', headerName: 'Authorization-Token', location: 'header' }),
    )
  })

  it('shows a connected account and offers connecting one instead of pasting', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(
      view({ source: 'connection', connection: { id: 'conn-1', name: 'Pets account', accountLabel: 'ops@example.com', connectorKey: 'x' } }),
    )
    const user = userEvent.setup()
    at()
    expect(await screen.findByTestId('api-key-summary')).toHaveTextContent('From Pets account (ops@example.com)')
    await user.click(screen.getByRole('button', { name: 'Replace key' }))
    expect(screen.getByRole('button', { name: /Connect an account/ })).toBeInTheDocument()
  })

  it('asks for a username with basic auth, and says what is missing', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view({ type: 'basic', headerName: null, location: null }))
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: 'Add a key' }))
    await user.type(screen.getByLabelText('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByTestId('api-key-error')).toHaveTextContent('Enter the username.')
    expect(apisApi.setKey).not.toHaveBeenCalled()
  })

  it('signs in with OAuth 2.0 when the spec declares it, coming back to the API', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(
      view({
        type: 'oauth2',
        headerName: null,
        location: null,
        oauth2: { flow: 'authorization_code', authorizationUrl: 'https://auth.cal.example.com/authorize', tokenUrl: 'https://auth.cal.example.com/token', scopes: ['events.read'] },
      }),
    )
    vi.mocked(credentialsApi.oauth2Authorize).mockResolvedValue({ authorizationUrl: 'https://auth.cal.example.com/authorize?state=s', state: 's' })
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, assign }, configurable: true })
    try {
      const user = userEvent.setup()
      at()
      await user.click(await screen.findByRole('button', { name: 'Add a key' }))
      expect(screen.getByText(/Sign in at auth.cal.example.com/)).toBeInTheDocument()
      await user.type(screen.getByLabelText('Client ID'), 'cid')
      await user.type(screen.getByLabelText('Client secret'), 'csecret')
      await user.click(screen.getByRole('button', { name: 'Sign in' }))

      await waitFor(() =>
        expect(credentialsApi.oauth2Authorize).toHaveBeenCalledWith(
          expect.objectContaining({
            apiId: 'api-1',
            clientId: 'cid',
            clientSecret: 'csecret',
            authorizationUrl: 'https://auth.cal.example.com/authorize',
            tokenUrl: 'https://auth.cal.example.com/token',
            scopes: ['events.read'],
            returnTo: '/apis/api-1',
          }),
        ),
      )
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.cal.example.com/authorize?state=s'))
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true })
    }
  })

  it('removes the key after asking', async () => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view({ source: 'key' }))
    vi.mocked(apisApi.removeKey).mockResolvedValue(view())
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    await user.click(await screen.findByRole('button', { name: 'Remove key' }))
    await waitFor(() => expect(apisApi.removeKey).toHaveBeenCalledWith('api-1'))
    expect(await screen.findByTestId('api-key-summary')).toHaveTextContent('No key yet')
  })
})

describe('the Key card asks before leaving', () => {
  beforeEach(() => {
    vi.mocked(apisApi.getKey).mockResolvedValue(view({ source: 'key' }))
  })

  it('asks while a key is half typed', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    fireEvent.change(screen.getByLabelText('Paste your key'), { target: { value: 'pk-half' } })
    await expectLeaveAsks(router)
  })

  it('leaves an opened but empty form without asking', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    await expectLeavesWithoutAsking(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }))
    fireEvent.change(screen.getByLabelText('Paste your key'), { target: { value: 'pk-half' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})
