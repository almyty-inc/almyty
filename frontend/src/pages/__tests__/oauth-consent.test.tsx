import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { OAuthConsentPage } from '../oauth/consent'
import { apiGet, apiPost } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

// The page reads the whole authorization request off the query string, and
// the global test setup hands back an empty one.
const QUERY = new URLSearchParams({
  org: 'acme',
  gateway: 'support',
  client_id: 'client-1',
  redirect_uri: 'https://client.example/callback',
  scope: 'mcp:tools',
  state: 'xyz',
  response_type: 'code',
  code_challenge: 'chal',
  code_challenge_method: 'S256',
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useSearchParams: () => [QUERY, vi.fn()] }
})

// testing-library's 1s default for findBy* is not enough for a react-query
// round trip when this file shares a worker with the rest of the suite. The
// budget only bounds how long a genuine failure takes to report.
const WAIT = { timeout: 10000 }

/**
 * A rejected approval must not strand the user.
 *
 * `approve()` reported its failure through the same `error` state the load
 * failure uses, and both the scope list and the footer rendered under
 * `{info && !error && ...}`. So an approval the backend refused -- expired
 * PKCE, revoked client, any 5xx -- removed Approve AND Deny, leaving
 * "Authorization failed. Please try again." with nothing left to try and the
 * MCP client parked on a redirect that never carried `access_denied`.
 */
describe('the OAuth consent screen after a failed approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiGet as any).mockResolvedValue({
      clientName: 'Claude Desktop',
      gatewayName: 'Support Gateway',
      scopes: ['mcp:tools'],
    })
    // jsdom has no navigation; a plain object makes the redirect observable.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '', pathname: '/oauth/consent', search: '' },
    })
  })

  async function approveAndFail(rejection: unknown) {
    ;(apiPost as any).mockRejectedValue(rejection)
    render(<OAuthConsentPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }, WAIT))
    await waitFor(() => expect(apiPost).toHaveBeenCalled(), WAIT)
  }

  it('keeps both buttons and the scope list after the backend refuses', async () => {
    await approveAndFail({
      response: { status: 400, data: { error_description: 'The code challenge has expired.' } },
    })

    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(
      'The code challenge has expired.',
    )
    // The two things the old code took away with the message.
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Try again|Approve/ })).toBeEnabled()
    expect(screen.getByText('Call this gateway’s tools')).toBeInTheDocument()
  })

  it('lets the user retry the approval', async () => {
    await approveAndFail(new Error('boom'))
    await screen.findByRole('alert', {}, WAIT)

    ;(apiPost as any).mockResolvedValue({ code: 'auth-code' })
    fireEvent.click(screen.getByRole('button', { name: /Try again|Approve/ }))

    await waitFor(
      () =>
        expect(window.location.href).toBe(
          'https://client.example/callback?code=auth-code&state=xyz',
        ),
      WAIT,
    )
  })

  it('still lets the user deny, so the client is told access_denied', async () => {
    await approveAndFail(new Error('boom'))
    await screen.findByRole('alert', {}, WAIT)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(window.location.href).toBe(
      'https://client.example/callback?error=access_denied&state=xyz',
    )
  })

  it('still hides the buttons when the request itself could not be validated', async () => {
    // A request that never validated has no trustworthy redirect target, so
    // the fatal branch is deliberately left alone.
    ;(apiGet as any).mockRejectedValue({
      response: { status: 400, data: { error_description: 'Unknown client.' } },
    })
    render(<OAuthConsentPage />)

    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent('Unknown client.')
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
  })
})

/**
 * The redirect target is assigned to `window.location.href` from the
 * dashboard's own origin, so it must be an http(s) URL and nothing else.
 * `javascript://localhost/%0a...` parses as a URL with host localhost; the
 * backend used to accept it at client registration, and this page would
 * then have run it as script on Approve or Deny.
 */
describe('the OAuth consent screen with a non-http redirect_uri', () => {
  const ORIGINAL = QUERY.get('redirect_uri')!

  beforeEach(() => {
    vi.clearAllMocks()
    QUERY.set('redirect_uri', 'javascript://localhost/%0aalert(document.domain)//')
    ;(apiGet as any).mockResolvedValue({
      clientName: 'Evil',
      gatewayName: 'Support Gateway',
      scopes: ['mcp:tools'],
    })
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '', pathname: '/oauth/consent', search: '' },
    })
  })

  afterEach(() => {
    QUERY.set('redirect_uri', ORIGINAL)
  })

  it('does not navigate to it when the user denies', async () => {
    render(<OAuthConsentPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }, WAIT))

    expect(window.location.href).toBe('')
    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(/invalid redirect URI/i)
  })

  it('does not navigate to it after an approval', async () => {
    ;(apiPost as any).mockResolvedValue({ code: 'auth-code' })
    render(<OAuthConsentPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }, WAIT))
    await waitFor(() => expect(apiPost).toHaveBeenCalled(), WAIT)

    expect(await screen.findByRole('alert', {}, WAIT)).toHaveTextContent(/invalid redirect URI/i)
    expect(window.location.href).toBe('')
  })
})
