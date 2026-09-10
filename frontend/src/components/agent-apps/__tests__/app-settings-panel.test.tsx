import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AppSettingsPanel } from '../app-settings-panel'
import { agentAppsApi, type AgentApp } from '@/lib/agent-apps'

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return { ...actual, agentAppsApi: { update: vi.fn() } }
})

const app = (over: Partial<AgentApp> = {}): AgentApp =>
  ({
    slug: 'acme-support',
    name: 'Acme Support',
    branding: {},
    authMode: 'public_link',
    capabilities: {},
    limits: null,
    privacy: null,
    isActive: true,
    ...over,
  }) as AgentApp

const save = () => fireEvent.click(screen.getByRole('button', { name: /Save/ }))
const sent = () => (agentAppsApi.update as any).mock.calls[0][1]

describe('AppSettingsPanel limits', () => {
  const onSaved = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(agentAppsApi.update as any).mockResolvedValue({})
  })

  it('stores a cost ceiling in cents, not in floating point currency', async () => {
    // A ceiling in floats is a rounding argument later.
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText(/Spend limit per run/), { target: { value: '0.50' } })
    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().limits.costCapCents).toBe(50)
  })

  it('rounds rather than truncating a fractional cent', async () => {
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText(/Spend limit per run/), { target: { value: '0.005' } })
    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().limits.costCapCents).toBe(1)
  })

  it('shows an existing ceiling back in whole currency', () => {
    render(<AppSettingsPanel app={app({ limits: { costCapCents: 250 } })} onSaved={onSaved} />)

    expect(screen.getByLabelText(/Spend limit per run/)).toHaveValue('2.5')
  })

  it('sends null for a limit left empty, not a zero', async () => {
    // Zero would read as "no requests allowed" rather than "unset".
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().limits).toEqual({
      costCapCents: null,
      perUserRateLimit: null,
      perIpRateLimit: null,
    })
  })

  it('keeps both rate ceilings separate', async () => {
    // The per-IP one covers surfaces where a visitor has no account.
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText(/per visitor/i), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText(/per IP address/i), { target: { value: '30' } })
    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().limits).toMatchObject({ perUserRateLimit: 120, perIpRateLimit: 30 })
  })

  it('explains that visitor limits are not one app-wide bucket', () => {
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    expect(screen.getByText(/identified by their sign-in or private chat cookie/i)).toBeInTheDocument()
    expect(screen.getByText(/not one shared bucket for the whole app/i)).toBeInTheDocument()
    expect(screen.getByText(/one fifth of its hourly value, with a minimum of 3/i)).toBeInTheDocument()
  })

  it('explains why an open product needs them', async () => {
    render(<AppSettingsPanel app={app({ authMode: 'public_link' })} onSaved={onSaved} />)

    expect(screen.getByText(/spends against your model keys/i)).toBeInTheDocument()
  })

  it('does not lecture a product that is not open to anyone', () => {
    render(<AppSettingsPanel app={app({ authMode: 'sso' })} onSaved={onSaved} />)

    expect(screen.queryByText(/spends against your model keys/i)).toBeNull()
    // The fields stay: a closed product may still want a ceiling.
    expect(screen.getByLabelText(/Spend limit per run/)).toBeInTheDocument()
  })

  it('shows the safe privacy defaults for an existing app with no stored overrides', () => {
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    expect(screen.getByRole('switch', { name: /download their data/i })).toBeChecked()
    expect(screen.getByRole('switch', { name: /delete their data/i })).toBeChecked()
    expect(screen.getByRole('switch', { name: /include visitor conversations/i })).not.toBeChecked()
    expect(screen.getByLabelText(/Delete visitor data after/i)).toHaveValue(null)
    expect(screen.getByText(/inherit the organization policy/i)).toBeInTheDocument()
  })

  it('saves per-app retention, visitor rights, and the shared-memory choice together', async () => {
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText(/Delete visitor data after/i), {
      target: { value: '14' },
    })
    fireEvent.click(screen.getByRole('switch', { name: /download their data/i }))
    fireEvent.click(screen.getByRole('switch', { name: /include visitor conversations/i }))
    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().privacy).toEqual({
      retentionDays: 14,
      visitorCanDelete: true,
      visitorCanExport: false,
      visitorMemory: true,
    })
  })

  it('refuses an invalid retention override before it reaches the API', () => {
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText(/Delete visitor data after/i), {
      target: { value: '1.5' },
    })

    expect(screen.getByText(/whole number of at least 1 day/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(agentAppsApi.update).not.toHaveBeenCalled()
  })
})
