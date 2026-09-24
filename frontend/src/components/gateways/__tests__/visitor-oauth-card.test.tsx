import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import { VisitorOAuthCard, type VisitorOAuthState } from '../visitor-oauth-card'

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getVisitorOAuth: vi.fn(),
    setVisitorOAuth: vi.fn(),
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

beforeEach(() => {
  vi.mocked(gatewaysApi.getVisitorOAuth).mockReset()
  vi.mocked(gatewaysApi.setVisitorOAuth).mockReset()
  vi.mocked(gatewaysApi.removeVisitorOAuth).mockReset()
})

describe('VisitorOAuthCard', () => {
  it('shows the redirect URI before anything is saved, then saves Google with the secret', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue({ provider: null, redirectUris: URIS })
    vi.mocked(gatewaysApi.setVisitorOAuth).mockResolvedValue(configured)
    const user = userEvent.setup()
    render(<VisitorOAuthCard gatewayId={GW} authMode="oauth" />)

    expect(await screen.findByText(URIS[0])).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save provider' })
    expect(save).toBeDisabled()

    await user.type(screen.getByLabelText('Client ID'), 'gid.apps.googleusercontent.com')
    await user.type(screen.getByLabelText('Client secret'), 'shh')
    await user.type(screen.getByLabelText('Allowed email domains'), 'acme.com')
    await user.click(save)

    await waitFor(() =>
      expect(gatewaysApi.setVisitorOAuth).toHaveBeenCalledWith(GW, {
        preset: 'google',
        clientId: 'gid.apps.googleusercontent.com',
        clientSecret: 'shh',
        allowedEmailDomains: 'acme.com',
      }),
    )
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Verified addresses at acme.com')).toBeInTheDocument()
    // The secret is never shown back.
    expect(screen.queryByDisplayValue('shh')).not.toBeInTheDocument()
  })

  it('editing without a new secret keeps the stored one', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue(configured)
    vi.mocked(gatewaysApi.setVisitorOAuth).mockResolvedValue(configured)
    const user = userEvent.setup()
    render(<VisitorOAuthCard gatewayId={GW} authMode="oauth" />)

    await user.click(await screen.findByRole('button', { name: 'Edit provider' }))
    expect(screen.getByLabelText('Client secret')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Save provider' }))
    await waitFor(() => expect(gatewaysApi.setVisitorOAuth).toHaveBeenCalled())
    expect(vi.mocked(gatewaysApi.setVisitorOAuth).mock.calls[0][1]).not.toHaveProperty('clientSecret')
  })

  it('removes the provider only after the one-line confirm', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue(configured)
    vi.mocked(gatewaysApi.removeVisitorOAuth).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<VisitorOAuthCard gatewayId={GW} authMode="oauth" />)

    await user.click(await screen.findByRole('button', { name: 'Remove provider' }))
    expect(gatewaysApi.removeVisitorOAuth).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(gatewaysApi.removeVisitorOAuth).toHaveBeenCalledWith(GW))
    expect(await screen.findByRole('button', { name: 'Save provider' })).toBeInTheDocument()
  })

  it('shows what the server refused', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue({ provider: null, redirectUris: URIS })
    vi.mocked(gatewaysApi.setVisitorOAuth).mockRejectedValue({
      response: { data: { message: 'Enter your Microsoft Entra tenant ID or primary domain.' } },
    })
    const user = userEvent.setup()
    render(<VisitorOAuthCard gatewayId={GW} authMode="oauth" />)
    await user.type(await screen.findByLabelText('Client ID'), 'c')
    await user.type(screen.getByLabelText('Client secret'), 's')
    await user.click(screen.getByRole('button', { name: 'Save provider' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/tenant/)
  })

  it('says when the surface is not using OAuth', async () => {
    vi.mocked(gatewaysApi.getVisitorOAuth).mockResolvedValue(configured)
    render(<VisitorOAuthCard gatewayId={GW} authMode="email_otp" />)
    expect(await screen.findByText(/not in use/)).toBeInTheDocument()
  })

  it('is on the gateway page, inline, with no dialog', () => {
    const page = readFileSync(join(__dirname, '../../../pages/gateway-detail.tsx'), 'utf8')
    expect(page).toMatch(/<VisitorOAuthCard gatewayId=\{gateway\.id\}/)
    const card = readFileSync(join(__dirname, '../visitor-oauth-card.tsx'), 'utf8')
    expect(card).not.toMatch(/Dialog/)
  })
})
