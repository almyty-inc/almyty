import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import { AllowedOriginsField, parseOrigin } from '../allowed-origins-card'

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

/** The field as the channel page holds it: its list is the page's. */
function Held({ onChange = vi.fn() }: { onChange?: (origins: string[]) => void }) {
  const [origins, setOrigins] = useState(['https://shop.example.com'])
  return (
    <AllowedOriginsField
      id="allowed-origin"
      what="this widget"
      value={origins}
      onChange={(next) => {
        setOrigins(next)
        onChange(next)
      }}
    />
  )
}

describe('AllowedOriginsField', () => {
  it('shows the sites, and has no save button of its own', () => {
    render(<Held />)
    expect(screen.getByText('https://shop.example.com')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
  })

  it('adds a site in canonical form to the page', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Held onChange={onChange} />)
    await user.type(screen.getByLabelText('Add a site'), 'https://Blog.Example.com/')
    await user.click(screen.getByRole('button', { name: /^add$/i }))
    expect(screen.getByText('https://blog.example.com')).toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(['https://shop.example.com', 'https://blog.example.com'])
  })

  it('refuses a wildcard inline and never adds it', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Held onChange={onChange} />)
    await user.type(screen.getByLabelText('Add a site'), 'https://*.example.com')
    await user.click(screen.getByRole('button', { name: /^add$/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/wildcards are not supported/i)
    expect(screen.queryByText('https://*.example.com')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removing the last site leaves an empty list, which the server reads as same-origin only', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Held onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Remove https://shop.example.com' }))
    expect(screen.getByText(/same-origin only/i)).toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})

describe('where the field is', () => {
  it('is on the channel page of the web chat and of the website widget, inline (no dialog)', () => {
    const channels = readFileSync(join(__dirname, '../../channels/hosted-channels.tsx'), 'utf8')
    expect(channels.match(/<AllowedOriginsField\s/g)).toHaveLength(2)
    const page = readFileSync(join(__dirname, '../../../pages/gateway-detail.tsx'), 'utf8')
    expect(page).not.toMatch(/AllowedOrigins/)
    const card = readFileSync(join(__dirname, '../allowed-origins-card.tsx'), 'utf8')
    expect(card).not.toMatch(/Dialog|Save allowed sites/)
  })
})
