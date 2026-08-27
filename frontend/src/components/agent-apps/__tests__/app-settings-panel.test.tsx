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

    fireEvent.change(screen.getByLabelText(/Cost ceiling/), { target: { value: '0.50' } })
    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().limits.costCapCents).toBe(50)
  })

  it('rounds rather than truncating a fractional cent', async () => {
    render(<AppSettingsPanel app={app()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText(/Cost ceiling/), { target: { value: '0.005' } })
    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().limits.costCapCents).toBe(1)
  })

  it('shows an existing ceiling back in whole currency', () => {
    render(<AppSettingsPanel app={app({ limits: { costCapCents: 250 } })} onSaved={onSaved} />)

    expect(screen.getByLabelText(/Cost ceiling/)).toHaveValue('2.5')
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

    fireEvent.change(screen.getByLabelText(/per user/i), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText(/per IP/i), { target: { value: '30' } })
    save()

    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    expect(sent().limits).toMatchObject({ perUserRateLimit: 120, perIpRateLimit: 30 })
  })

  it('explains why an open product needs them', async () => {
    render(<AppSettingsPanel app={app({ authMode: 'public_link' })} onSaved={onSaved} />)

    expect(screen.getByText(/spends against your model keys/i)).toBeInTheDocument()
  })

  it('does not lecture a product that is not open to anyone', () => {
    render(<AppSettingsPanel app={app({ authMode: 'sso' })} onSaved={onSaved} />)

    expect(screen.queryByText(/spends against your model keys/i)).toBeNull()
    // The fields stay: a closed product may still want a ceiling.
    expect(screen.getByLabelText(/Cost ceiling/)).toBeInTheDocument()
  })
})
