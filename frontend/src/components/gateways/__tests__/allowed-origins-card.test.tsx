import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import { AllowedOriginsCard, parseOrigin } from '../allowed-origins-card'

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    update: vi.fn().mockResolvedValue({}),
  },
}))

import { gatewaysApi } from '@/lib/api'

const widget = {
  id: '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  type: 'chat_widget',
  configuration: { widget: { title: 'Help' }, allowedOrigins: ['https://shop.example.com'] },
}

beforeEach(() => {
  vi.mocked(gatewaysApi.update).mockClear()
})

describe('parseOrigin (mirrors the server)', () => {
  it('canonicalises', () => {
    expect(parseOrigin('https://Shop.Example.com/')).toEqual({ origin: 'https://shop.example.com' })
    expect(parseOrigin('https://shop.example.com:443')).toEqual({ origin: 'https://shop.example.com' })
  })

  it.each(['https://*.example.com', 'https://example.com/path', 'ftp://example.com', 'example.com', ''])(
    'refuses %j',
    (value) => expect(parseOrigin(value)).toHaveProperty('error'),
  )
})

describe('AllowedOriginsCard', () => {
  it('shows the saved sites', () => {
    render(<AllowedOriginsCard gateway={widget} />)
    expect(screen.getByText('https://shop.example.com')).toBeInTheDocument()
  })

  it('adds a site in canonical form and saves it merged into the configuration', async () => {
    const user = userEvent.setup()
    render(<AllowedOriginsCard gateway={widget} />)
    await user.type(screen.getByLabelText('Add a site'), 'https://Blog.Example.com/')
    await user.click(screen.getByRole('button', { name: /^add$/i }))
    expect(screen.getByText('https://blog.example.com')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /save allowed sites/i }))
    await waitFor(() => expect(gatewaysApi.update).toHaveBeenCalledTimes(1))
    expect(gatewaysApi.update).toHaveBeenCalledWith(widget.id, {
      configuration: {
        widget: { title: 'Help' },
        allowedOrigins: ['https://shop.example.com', 'https://blog.example.com'],
      },
    })
  })

  it('refuses a wildcard inline and never saves it', async () => {
    const user = userEvent.setup()
    render(<AllowedOriginsCard gateway={widget} />)
    await user.type(screen.getByLabelText('Add a site'), 'https://*.example.com')
    await user.click(screen.getByRole('button', { name: /^add$/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/wildcards are not supported/i)
    expect(screen.queryByText('https://*.example.com')).not.toBeInTheDocument()
    // Nothing changed, so there is nothing to save.
    expect(screen.getByRole('button', { name: /save allowed sites/i })).toBeDisabled()
  })

  it('removing the last site saves an empty list, which the server reads as same-origin only', async () => {
    const user = userEvent.setup()
    render(<AllowedOriginsCard gateway={widget} />)
    await user.click(screen.getByRole('button', { name: 'Remove https://shop.example.com' }))
    expect(screen.getByText(/same-origin only/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /save allowed sites/i }))
    await waitFor(() =>
      expect(gatewaysApi.update).toHaveBeenCalledWith(widget.id, {
        configuration: { widget: { title: 'Help' }, allowedOrigins: [] },
      }),
    )
  })
})

describe('where the card is', () => {
  it('is on the web app page for a hosted chat, and on the gateway page for a widget, inline (no dialog)', () => {
    const web = readFileSync(join(__dirname, '../../agent-apps/web-place.tsx'), 'utf8')
    expect(web).toMatch(/<AllowedOriginsCard\s/)
    const page = readFileSync(join(__dirname, '../../../pages/gateway-detail.tsx'), 'utf8')
    expect(page).toMatch(/gateway\.type === 'chat_widget' \|\| \(gateway\.type === 'hosted_chat' && !managedBy\)\) && \(\s*<AllowedOriginsCard/)
    const card = readFileSync(join(__dirname, '../allowed-origins-card.tsx'), 'utf8')
    expect(card).not.toMatch(/Dialog/)
  })
})
