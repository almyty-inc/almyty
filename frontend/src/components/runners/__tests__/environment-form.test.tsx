import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/setup'
import { EnvironmentForm } from '../environment-form'
import type { HostedEnvironment, HostedSettings } from '../hosted-shared'

/** What the server sends in `settings` (GET /environments). */
const SERVER_SETTINGS: HostedSettings = {
  images: ['standard', 'standard-browser'],
  idleTimeoutMinutes: { default: 15, min: 5, max: 120 },
  suspendedRetention: { keepDays: 30 },
}

const entitlement = { enabled: false, isLoading: false }
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => entitlement }))
vi.mock('@/lib/api', () => ({ organizationsApi: { getTeams: vi.fn().mockResolvedValue([{ id: 't1', name: 'Platform', isDefault: false }]) } }))

const saved: HostedEnvironment = {
  id: 'e1',
  name: 'web-app',
  description: null,
  ownerUserId: 'me',
  visibility: 'private',
  teamId: null,
  repo: { url: 'https://github.com/acme/web', ref: 'main', connectionId: 'c1' },
  image: { base: 'standard' },
  setupScript: 'npm ci',
  egress: { allowHosts: ['github.com'], allowBinaries: ['git'] },
  resourceClass: 'small',
  idleTimeoutMinutes: 30,
  version: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
}

describe('EnvironmentForm', () => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  Element.prototype.scrollIntoView = vi.fn()
  beforeEach(() => {
    entitlement.enabled = false
  })

  it('shows the default idle timeout and its bounds, and refuses a bad form without sending it', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} submitLabel="Create environment" onSubmit={submit} />)
    expect(screen.getByLabelText('Park after')).toHaveValue(15)
    expect(screen.getByText(/From 5 to 120; 15 if you leave it/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Name'), 'Web App')
    await user.clear(screen.getByLabelText('Park after'))
    await user.type(screen.getByLabelText('Park after'), '500')
    await user.click(screen.getByRole('button', { name: 'Create environment' }))
    expect(screen.getByText(/Use lowercase letters, digits and dashes/)).toBeInTheDocument()
    expect(screen.getByText('Pick a whole number from 5 to 120.')).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
  })

  it('names a site that cannot be allowed as soon as it is typed', async () => {
    const user = userEvent.setup()
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} submitLabel="Create" onSubmit={vi.fn()} />)
    await user.type(screen.getByLabelText('Allowed sites'), '*.github.com')
    expect(screen.getByText(/Not a site name: \*\.github\.com/)).toBeInTheDocument()
  })

  it('sends every field in the shape the API takes', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} submitLabel="Create environment" onSubmit={submit} />)
    await user.type(screen.getByLabelText('Name'), 'web-app')
    await user.type(screen.getByLabelText(/^Repository/), 'https://github.com/acme/web')
    await user.type(screen.getByLabelText(/^Setup script/), 'npm ci')
    await user.type(screen.getByLabelText('Allowed sites'), 'GitHub.com{enter}registry.npmjs.org')
    await user.click(screen.getByRole('button', { name: 'Create environment' }))
    expect(submit).toHaveBeenCalledWith({
      name: 'web-app',
      repo: { url: 'https://github.com/acme/web', ref: null },
      image: { base: 'standard' },
      setupScript: 'npm ci',
      egress: { allowHosts: ['github.com', 'registry.npmjs.org'] },
      idleTimeoutMinutes: 15,
      allowVendorKeys: false,
      visibility: 'private',
      teamId: null,
    })
  })

  it('offers the images the install lists', async () => {
    const user = userEvent.setup()
    render(<EnvironmentForm organizationId="o1" settings={{ ...SERVER_SETTINGS, images: ['standard', 'standard-browser'] }} submitLabel="Create" onSubmit={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Starting point' }))
    expect(await screen.findByRole('option', { name: 'Standard with a web browser' })).toBeInTheDocument()
  })

  it('keeps provider keys off the machine unless turned on, and sends the choice', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} initial={saved} submitLabel="Save changes" onSubmit={submit} />)
    const toggle = screen.getByRole('switch', { name: "Let coding tools use the provider's own key instead of almyty" })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/no provider key is put on the machine/)).toBeInTheDocument()
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(submit.mock.calls[0][0].allowVendorKeys).toBe(true)
  })

  it('shows a saved allowVendorKeys as on', () => {
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} initial={{ ...saved, allowVendorKeys: true }} submitLabel="Save" onSubmit={vi.fn()} />)
    expect(screen.getByRole('switch', { name: "Let coding tools use the provider's own key instead of almyty" })).toBeChecked()
  })

  it('keeps what the page does not show (the repository connection, allowed programs) when saving an edit', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} initial={saved} submitLabel="Save changes" onSubmit={submit} />)
    expect(screen.getByLabelText('Park after')).toHaveValue(30)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const body = submit.mock.calls[0][0]
    expect(body.repo).toEqual({ url: 'https://github.com/acme/web', ref: 'main', connectionId: 'c1' })
    expect(body.egress).toEqual({ allowHosts: ['github.com'], allowBinaries: ['git'] })
  })

  it("says plainly that a private environment is still visible to the organization's admins", () => {
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} submitLabel="Create" onSubmit={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /Only you/ })).toHaveTextContent("Your organization's admins can still see it, and it passes to them if you leave.")
    expect(screen.queryByText(/Not even org admins/)).toBeNull()
  })
  it('locks team and organization sharing with a plan hint when the plan lacks it', () => {
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} submitLabel="Create" onSubmit={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /Only you/ })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /One team/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Everyone/ })).toBeDisabled()
    expect(screen.getByTestId('environment-sharing-locked')).toHaveTextContent('Business')
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/billing')
  })

  it('offers sharing when the plan includes it', () => {
    entitlement.enabled = true
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} submitLabel="Create" onSubmit={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /Everyone/ })).toBeEnabled()
    expect(screen.queryByTestId('environment-sharing-locked')).toBeNull()
  })

  it('keeps an already shared environment shared after a downgrade', () => {
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} initial={{ ...saved, visibility: 'org' }} submitLabel="Save" onSubmit={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /Everyone/ })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /Everyone/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /One team/ })).toBeDisabled()
  })

  it('is read-only and has no save button when disabled', () => {
    render(<EnvironmentForm organizationId="o1" settings={SERVER_SETTINGS} initial={saved} submitLabel="Save changes" disabled onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })
})
