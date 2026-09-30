import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import {
  VisitorOAuthCard,
  visitorOAuthBody,
  visitorOAuthProblem,
  draftFrom,
  type VisitorOAuthDraft,
  type VisitorOAuthState,
} from '../visitor-oauth-card'

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getVisitorOAuth: vi.fn(),
    removeVisitorOAuth: vi.fn(),
  },
}))

import { gatewaysApi } from '@/lib/api'

const GW = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const URIS = ['https://acme.almyty.app/api/public/chat/acme/auth/oauth/callback']

const configured: VisitorOAuthState = {
  provider: {
    preset: 'google',
    providerLabel: 'Google',
    issuer: 'https://accounts.google.com',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    discoveryUrl: null,
    tenant: null,
    clientId: 'gid.apps.googleusercontent.com',
    scopes: ['openid', 'email', 'profile'],
    allowedEmailDomains: ['acme.com'],
    hasClientSecret: true,
    updatedAt: '2026-09-24T10:00:00Z',
  },
  redirectUris: URIS,
}

/** The card as the channel page holds it: the draft is the page's, and the page's Save sends it. */
let latest: VisitorOAuthDraft | null = null
function Held({ authMode = 'oauth', error }: { authMode?: string; error?: string }) {
  const [draft, setDraft] = useState<VisitorOAuthDraft | null>(null)
  const hand = (next: VisitorOAuthDraft | null) => {
    latest = next
    setDraft(next)
  }
  return <VisitorOAuthCard gatewayId={GW} authMode={authMode} draft={draft} onDraftChange={hand} error={error} />
}

beforeEach(() => {
  latest = null
  vi.mocked(gatewaysApi.getVisitorOAuth).mockReset()
  vi.mocked(gatewaysApi.removeVisitorOAuth).mockReset()
})

describe('VisitorOAuthCard', () => {
  it('shows the redirect URI before anything is saved, and hands the page a Google provider with its secret', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue({ provider: null, redirectUris: URIS })
    const user = userEvent.setup()
    render(<Held />)

    expect(await screen.findByText(URIS[0])).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()

    await user.type(screen.getByLabelText('Client ID'), 'gid.apps.googleusercontent.com')
    await user.type(screen.getByLabelText('Client secret'), 'shh')
    await user.type(screen.getByLabelText('Allowed email domains'), 'acme.com')

    expect(visitorOAuthBody(latest!)).toEqual({
      preset: 'google',
      clientId: 'gid.apps.googleusercontent.com',
      clientSecret: 'shh',
      allowedEmailDomains: 'acme.com',
    })
  })

  it('says what is missing before the page saves', () => {
    expect(visitorOAuthProblem(draftFrom(null), null)).toBe('Enter the client ID from the provider.')
    expect(visitorOAuthProblem({ ...draftFrom(null), clientId: 'c' }, null)).toBe('Enter the client secret from the provider.')
    expect(visitorOAuthProblem(draftFrom(configured.provider), configured.provider)).toBeNull()
  })

  it('editing without a new secret keeps the stored one', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue(configured)
    const user = userEvent.setup()
    render(<Held />)

    await user.click(await screen.findByRole('button', { name: 'Edit provider' }))
    expect(screen.getByLabelText('Client secret')).toHaveValue('')
    expect(visitorOAuthBody(latest!)).not.toHaveProperty('clientSecret')
    await user.click(screen.getByRole('button', { name: 'Keep the saved provider' }))
    expect(latest).toBeNull()
  })

  it('removes the provider only after the one-line confirm', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue(configured)
    vi.mocked(gatewaysApi.removeVisitorOAuth).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<Held />)

    await user.click(await screen.findByRole('button', { name: 'Remove provider' }))
    expect(gatewaysApi.removeVisitorOAuth).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(gatewaysApi.removeVisitorOAuth).toHaveBeenCalledWith(GW))
    expect(await screen.findByLabelText('Client ID')).toBeInTheDocument()
  })

  it('shows what the save refused', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue({ provider: null, redirectUris: URIS })
    render(<Held error="Enter your Microsoft Entra tenant ID or primary domain." />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/tenant/)
  })

  it('says when the surface is not using OAuth', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue(configured)
    render(<Held authMode="email_otp" />)
    expect(await screen.findByText(/not in use/)).toBeInTheDocument()
  })

  it('is on the web chat channel page, inline, with no dialog and no save of its own', () => {
    const web = readFileSync(join(__dirname, '../../channels/hosted-channels.tsx'), 'utf8')
    expect(web).toMatch(/<VisitorOAuthCard\s/)
    const card = readFileSync(join(__dirname, '../visitor-oauth-card.tsx'), 'utf8')
    expect(card).not.toMatch(/Dialog|Save provider|setVisitorOAuth/)
  })

  it('offers Google, Microsoft and GitHub first, as tiles, and asks for a URL only for Other', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue({ provider: null, redirectUris: URIS })
    const user = userEvent.setup()
    render(<Held />)

    const tiles = within(await screen.findByRole('list', { name: 'Provider' })).getAllByRole('button')
    expect(tiles.map((t) => t.textContent)).toEqual(['GGoogle', 'MMicrosoft', 'GHGitHub', '…Other'])
    expect(screen.getByTestId('visitor-oauth-preset-google')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByLabelText('Issuer or discovery URL')).toBeNull()

    await user.click(screen.getByTestId('visitor-oauth-preset-github'))
    expect(screen.queryByLabelText('Issuer or discovery URL')).toBeNull()

    await user.click(screen.getByTestId('visitor-oauth-preset-oidc'))
    expect(screen.getByLabelText('Issuer or discovery URL')).toBeInTheDocument()
  })

  it('keeps endpoints, keys and scopes under Advanced', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue({ provider: null, redirectUris: URIS })
    const user = userEvent.setup()
    render(<Held />)

    await user.click(await screen.findByTestId('visitor-oauth-preset-oidc'))
    expect(screen.queryByLabelText('Scopes')).toBeNull()
    expect(screen.queryByLabelText('Token endpoint')).toBeNull()
    expect(screen.queryByLabelText('JWKS URI')).toBeNull()

    await user.click(screen.getByRole('button', { name: /^Advanced/ }))
    expect(screen.getByLabelText('Scopes')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Enter the endpoints by hand' }))
    expect(screen.queryByLabelText('Issuer or discovery URL')).toBeNull()

    await user.type(screen.getByLabelText('Issuer'), 'https://id.example.com')
    await user.type(screen.getByLabelText('Authorization endpoint'), 'https://id.example.com/authorize')
    await user.type(screen.getByLabelText('Token endpoint'), 'https://id.example.com/token')
    await user.type(screen.getByLabelText('JWKS URI'), 'https://id.example.com/jwks')
    await user.type(screen.getByLabelText('Client ID'), 'c')
    await user.type(screen.getByLabelText('Client secret'), 's')

    const body = visitorOAuthBody(latest!)
    expect(body).toMatchObject({
      preset: 'oidc',
      issuer: 'https://id.example.com',
      authorizationEndpoint: 'https://id.example.com/authorize',
      tokenEndpoint: 'https://id.example.com/token',
      jwksUri: 'https://id.example.com/jwks',
    })
    expect(body).not.toHaveProperty('discoveryUrl')
  })
})
