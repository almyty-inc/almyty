import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { AppDetailPage } from '../app-detail'

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useParams: () => ({ slug: 'acme-support' }) }
})

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return {
    ...actual,
    agentAppsApi: {
      getById: vi.fn(),
      check: vi.fn(),
      removeDistribution: vi.fn(),
      checkDistribution: vi.fn().mockResolvedValue({ ok: true, refusals: [] }),
      platforms: vi.fn().mockResolvedValue([]),
      builds: vi.fn().mockResolvedValue([]),
      capabilities: vi.fn().mockResolvedValue({ canBuild: false, buildReason: null, signing: [] }),
    },
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    agentsApi: { getAll: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'Copilot' }]) },
    credentialsApi: { getAll: vi.fn().mockResolvedValue({ data: [] }) },
  }
})

import { agentAppsApi } from '@/lib/agent-apps'

const app = (over: any = {}) => ({
  slug: 'acme-support',
  name: 'Acme Support',
  branding: { appName: 'Customer Care Console' },
  agentIds: ['agent-1'],
  authMode: 'public_link',
  capabilities: {},
  limits: { costCapCents: 500, perUserRateLimit: 60, perIpRateLimit: 60 },
  distributions: [
    { id: 'd-1', target: 'web', status: 'live', configuration: {} },
    { id: 'd-2', target: 'slack', status: 'draft', configuration: {} },
  ],
  ...over,
})

describe('AppDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(agentAppsApi.getById as any).mockResolvedValue(app())
    ;(agentAppsApi.check as any).mockResolvedValue({ ok: true, refusals: [] })
  })

  it('is a detail page, not a canvas: header, tabs, and distribution cards', async () => {
    render(<AppDetailPage />)

    // The product name and slug in a header.
    expect(await screen.findByRole('heading', { name: 'Customer Care Console' })).toBeInTheDocument()
    // Tabbed sections, like every other detail page.
    expect(screen.getByRole('tab', { name: /Distributions/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Agents/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Settings/ })).toBeInTheDocument()
    // Distributions as cards with their status, not nodes on a graph.
    expect(screen.getByText('Web app')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText('Slack')).toBeInTheDocument()
  })

  it('shows what is blocking the product from shipping', async () => {
    ;(agentAppsApi.check as any).mockResolvedValue({
      ok: false,
      refusals: [{ code: 'NO_AGENTS', message: 'A product needs at least one agent.' }],
    })
    render(<AppDetailPage />)

    expect(await screen.findByText('A product needs at least one agent.')).toBeInTheDocument()
  })

  it('says it is ready to ship when nothing is blocking', async () => {
    render(<AppDetailPage />)
    expect(await screen.findByText(/Ready to ship/)).toBeInTheDocument()
  })

  it('opens a dialog to edit a distribution, not a drawer', async () => {
    render(<AppDetailPage />)

    fireEvent.click(await screen.findByText('Slack'))

    // A centered dialog, the same edit pattern as everywhere else.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    await waitFor(() =>
      expect(agentAppsApi.checkDistribution).toHaveBeenCalledWith('acme-support', 'slack'),
    )
  })

  it('offers to ship somewhere from the header', async () => {
    render(<AppDetailPage />)
    expect(await screen.findAllByRole('button', { name: /Ship somewhere/ })).not.toHaveLength(0)
  })

  it('invites a first distribution when there are none', async () => {
    ;(agentAppsApi.getById as any).mockResolvedValue(app({ distributions: [] }))
    render(<AppDetailPage />)

    expect(await screen.findByText(/Not shipping anywhere yet/)).toBeInTheDocument()
  })
})
