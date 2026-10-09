import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '@/test/setup'
import { HostedEnvironmentsTab, HostedIntro } from '../hosted-environments-tab'

vi.mock('@/lib/api', () => ({
  environmentsApi: { list: vi.fn(), usage: vi.fn(), workspaces: vi.fn() },
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
const usage = environmentsApi.usage as ReturnType<typeof vi.fn>
const workspaces = environmentsApi.workspaces as ReturnType<typeof vi.fn>

const SETTINGS = { images: ['standard', 'standard-browser'], idleTimeoutMinutes: { min: 5, max: 120, default: 15 }, suspendedRetention: { keepDays: 30 } }

const env = (id: string, name: string, over: any = {}) => ({
  id,
  name,
  visibility: 'private',
  teamId: null,
  repo: { url: `https://github.com/acme/${name}` },
  image: { base: 'standard' },
  egress: { allowHosts: [] },
  idleTimeoutMinutes: 15,
  mine: null,
  ...over,
})
const mine = (state: string, status: string, lastActiveAt: string | null, replicas = 1) => ({
  workspaceId: `w-${state}`,
  status,
  lastActiveAt,
  machine: { id: 'h', state, desired: { replicas }, lastError: null },
})

describe('HostedEnvironmentsTab', () => {
  beforeEach(() => {
    list.mockReset()
    usage.mockReset()
    workspaces.mockReset()
    usage.mockResolvedValue({ from: '', to: '', environments: [], organization: null })
  })

  it('says plainly that hosted machines are off when the server says so', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: false, settings: SETTINGS })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText(/Hosted machines aren't available on this server/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New environment' })).toBeNull()
  })

  it('offers to create the first environment on a page', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: true, settings: SETTINGS })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('No hosted environments yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New environment' })).toBeInTheDocument()
  })

  it("shows the caller's machine from each row's `mine`, without a request per row", async () => {
    list.mockResolvedValue({
      success: true,
      enabled: true,
      settings: SETTINGS,
      data: [
        env('e1', 'web-app', { mine: mine('ready', 'active', new Date().toISOString()) }),
        env('e2', 'data-jobs', { image: { base: 'standard-browser' }, mine: mine('suspended', 'suspended', '2026-10-01T12:00:00Z', 0) }),
        env('e3', 'docs'),
        env('e4', 'fresh', { mine: mine('pending', 'suspended', null, 0) }),
      ],
    })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('web-app')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('parked')).toBeInTheDocument()
    expect(screen.getByText('Files kept until Oct 31, 2026')).toBeInTheDocument()
    expect(screen.getByText('Not started yet')).toBeInTheDocument()
    expect(screen.getByText('not started')).toBeInTheDocument()
    expect(screen.getByText('Standard with a web browser')).toBeInTheDocument()
    expect(workspaces).not.toHaveBeenCalled()
  })

  it("shows each environment's minutes this month, and the organization's total only when the API gives it", async () => {
    list.mockResolvedValue({ success: true, enabled: true, settings: SETTINGS, data: [env('e1', 'web-app'), env('e2', 'data-jobs')] })
    usage.mockResolvedValue({ from: '', to: '', environments: [{ environmentId: 'e1', name: 'web-app', minutes: 185, byClass: {} }], organization: { minutes: 600, byClass: {} } })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('3 h 5 min')).toBeInTheDocument()
    expect(screen.getByText('0 min')).toBeInTheDocument()
    expect(screen.getByTestId('hosted-org-usage')).toHaveTextContent("Your organization's hosted machines ran 10 h this month.")
  })

  it('leaves the organization total out for a member', async () => {
    list.mockResolvedValue({ success: true, enabled: true, settings: SETTINGS, data: [env('e1', 'web-app')] })
    usage.mockResolvedValue({ from: '', to: '', environments: [{ environmentId: 'e1', name: 'web-app', minutes: 12, byClass: {} }], organization: null })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('12 min')).toBeInTheDocument()
    expect(screen.queryByTestId('hosted-org-usage')).toBeNull()
  })

  it('uses the retention the API reports for the files date', async () => {
    list.mockResolvedValue({ success: true, enabled: true, settings: { ...SETTINGS, suspendedRetention: { keepDays: 7 } }, data: [env('e2', 'data-jobs', { mine: mine('suspended', 'suspended', '2026-10-01T12:00:00Z', 0) })] })
    render(<HostedEnvironmentsTab />)
    await waitFor(() => expect(screen.getByText('Files kept until Oct 8, 2026')).toBeInTheDocument())
  })
})

describe('HostedIntro', () => {
  beforeEach(() => {
    usage.mockResolvedValue({ from: '', to: '', environments: [], organization: null })
  })

  it('says what hosted machines do and links to their guide, not the runner one', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: true, settings: SETTINGS })
    render(<HostedIntro />)
    expect(await screen.findByText(/almyty starts a machine for your agent when it needs one/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'How it works' })).toHaveAttribute('href', 'https://docs.almyty.com/hosted-machines')
    expect(screen.queryByText(/A runner connects a machine you control/)).toBeNull()
  })

  it('stays out of the way when hosted machines are off', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: false, settings: SETTINGS })
    render(<><HostedIntro /><HostedEnvironmentsTab /></>)
    expect(await screen.findByText(/Hosted machines aren't available on this server/)).toBeInTheDocument()
    expect(screen.queryByTestId('hosted-intro')).toBeNull()
  })
})
