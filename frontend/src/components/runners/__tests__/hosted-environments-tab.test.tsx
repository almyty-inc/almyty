import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '@/test/setup'
import { HostedEnvironmentsTab, HostedIntro } from '../hosted-environments-tab'

vi.mock('@/lib/api', () => ({
  environmentsApi: { list: vi.fn(), workspaces: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/store/organization', () => {
  const state = { currentOrganization: { id: 'o1', name: 'Org' } }
  return { useOrganizationStore: (select?: any) => (select ? select(state) : state) }
})
vi.mock('@/store/auth', () => {
  const state = { user: { id: 'me' } }
  return { useAuthStore: (select?: any) => (select ? select(state) : state) }
})

import { environmentsApi } from '@/lib/api'

const list = environmentsApi.list as ReturnType<typeof vi.fn>
const workspaces = environmentsApi.workspaces as ReturnType<typeof vi.fn>

const env = (id: string, name: string, over: any = {}) => ({
  id,
  name,
  visibility: 'private',
  teamId: null,
  repo: { url: `https://github.com/acme/${name}` },
  image: { base: 'standard' },
  egress: { allowHosts: [] },
  idleTimeoutMinutes: 15,
  ...over,
})

describe('HostedEnvironmentsTab', () => {
  beforeEach(() => {
    list.mockReset()
    workspaces.mockReset()
  })

  it('says plainly that hosted machines are off when the server says so', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: false })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText(/Hosted machines aren't available on this server/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New environment' })).toBeNull()
  })

  it('offers to create the first environment on a page', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: true })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('No hosted environments yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New environment' })).toBeInTheDocument()
  })

  it("lists environments with the caller's machine: running, parked with the date its files go, or not started", async () => {
    list.mockResolvedValue({ success: true, enabled: true, data: [env('e1', 'web-app'), env('e2', 'data-jobs', { image: { base: 'standard-browser' } }), env('e3', 'docs')] })
    workspaces.mockImplementation(async (id: string) => {
      if (id === 'e1') return [{ id: 'w1', ownerUserId: 'me', agentId: null, status: 'active', lastActiveAt: new Date().toISOString(), createdAt: '2026-10-01T00:00:00Z', machine: { id: 'h1', state: 'ready', lastActiveAt: null, lastError: null } }]
      if (id === 'e2') return [{ id: 'w2', ownerUserId: 'me', agentId: null, status: 'suspended', lastActiveAt: '2026-10-01T12:00:00Z', createdAt: '2026-09-01T00:00:00Z', machine: { id: 'h2', state: 'suspended', lastActiveAt: null, lastError: null } }]
      return []
    })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('web-app')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('running')).toBeInTheDocument())
    expect(screen.getByText('parked')).toBeInTheDocument()
    expect(screen.getByText('Files kept until Oct 31, 2026')).toBeInTheDocument()
    expect(screen.getByText('Not started yet')).toBeInTheDocument()
    expect(screen.getByText('Standard with a web browser')).toBeInTheDocument()
  })

  it('uses the retention the API reports for the files date', async () => {
    list.mockResolvedValue({ success: true, enabled: true, settings: { suspendedRetention: { keepDays: 7 } }, data: [env('e2', 'data-jobs')] })
    workspaces.mockResolvedValue([{ id: 'w2', ownerUserId: 'me', agentId: null, status: 'suspended', lastActiveAt: '2026-10-01T12:00:00Z', createdAt: '2026-09-01T00:00:00Z', machine: { id: 'h2', state: 'suspended', lastActiveAt: null, lastError: null } }])
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('Files kept until Oct 8, 2026')).toBeInTheDocument()
  })
})

describe('HostedIntro', () => {
  it('says what hosted machines do and links to their guide, not the runner one', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: true })
    render(<HostedIntro />)
    expect(await screen.findByText(/almyty starts a machine for your agent when it needs one/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'How it works' })).toHaveAttribute('href', 'https://docs.almyty.com/hosted-machines')
    expect(screen.queryByText(/A runner connects a machine you control/)).toBeNull()
  })

  it('stays out of the way when hosted machines are off', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: false })
    render(<><HostedIntro /><HostedEnvironmentsTab /></>)
    expect(await screen.findByText(/Hosted machines aren't available on this server/)).toBeInTheDocument()
    expect(screen.queryByTestId('hosted-intro')).toBeNull()
  })
})
