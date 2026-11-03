import { describe, it, expect, vi } from 'vitest'
// The shared setup stubs useLocation; this page reads the real query string.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import { SsoErrorPage } from '../sso-error'

/**
 * A refused single sign-on (a deactivated member, above all) left the
 * browser on a raw JSON error. The API now sends it here with a reason
 * code, and the page says what happened and what to do, in its own words.
 */
describe('SsoErrorPage', () => {
  const at = (search: string) =>
    render(
      <MemoryRouter initialEntries={[`/auth/sso-error${search}`]}>
        <SsoErrorPage />
      </MemoryRouter>,
    )

  it('tells a deactivated member their access was turned off, and who can fix it', () => {
    at('?reason=deactivated')
    expect(screen.getByRole('heading', { name: 'Your access has been turned off' })).toBeInTheDocument()
    expect(screen.getByText(/ask an admin of the organization to reactivate you/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/auth/login')
  })

  it('never shows text from the link itself', () => {
    at('?reason=%3Cscript%3Ecall%20555-0100%3C%2Fscript%3E')
    expect(screen.getByRole('heading', { name: "Single sign-on didn't complete" })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('555-0100')
  })
})
