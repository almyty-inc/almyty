import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { EnvironmentNewPage } from '../environment-new'
import { EnvironmentDetailPage } from '../environment-detail'

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useParams: () => ({ id: 'e1' }), useNavigate: () => navigate }
})
vi.mock('../../lib/api', () => ({
  environmentsApi: { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), workspaces: vi.fn(), suspend: vi.fn(), release: vi.fn(), usage: vi.fn(), runs: vi.fn() },
  agentsApi: { getAll: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]), getMembers: vi.fn().mockResolvedValue([{ userId: 'them', firstName: 'Sam', lastName: 'Rivera' }]) },
}))
vi.mock('../../hooks/use-entitlement', () => ({ useEntitlement: () => ({ enabled: false, isLoading: false }) }))
const role = { canManage: false }
vi.mock('../../hooks/use-organization-role', () => ({ useOrganizationRole: () => role }))
vi.mock('../../store/organization', () => {
  const state = { currentOrganization: { id: 'o1', name: 'Org' } }
  return { useOrganizationStore: (select?: any) => (select ? select(state) : state) }
})
vi.mock('../../store/auth', () => {
  const state = { user: { id: 'me' } }
  return { useAuthStore: (select?: any) => (select ? select(state) : state) }
})
const notes = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('../../store/app', () => ({ useNotifications: () => notes }))

import { agentsApi, environmentsApi } from '../../lib/api'

const api = environmentsApi as unknown as Record<string, ReturnType<typeof vi.fn>>
const getAgents = agentsApi.getAll as ReturnType<typeof vi.fn>

const ENV = {
  id: 'e1',
  name: 'web-app',
  description: null,
  ownerUserId: 'me',
  visibility: 'private',
  teamId: null,
  repo: { url: 'https://github.com/acme/web', ref: null },
  image: { base: 'standard' },
  setupScript: null,
  egress: { allowHosts: ['github.com'] },
  resourceClass: 'small',
  idleTimeoutMinutes: 15,
  version: 1,
  createdAt: '2026-10-01T00:00:00Z',
}
const running = { id: 'w1', ownerUserId: 'me', agentId: null, environmentId: 'e1', status: 'active', lastActiveAt: new Date().toISOString(), createdAt: '2026-10-01T00:00:00Z', machine: { id: 'h1', state: 'ready', desired: { replicas: 1 }, lastActiveAt: null, lastError: null } }
const SETTINGS = { images: ['standard', 'standard-browser'], idleTimeoutMinutes: { min: 5, max: 120, default: 15 }, suspendedRetention: { keepDays: 30 } }

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  navigate.mockReset()
  notes.success.mockReset()
  notes.error.mockReset()
  role.canManage = false
  api.list.mockResolvedValue({ success: true, data: [ENV], enabled: true, settings: SETTINGS })
  api.getById.mockResolvedValue(ENV)
  api.workspaces.mockResolvedValue([])
  api.usage.mockResolvedValue({ from: '', to: '', environments: [], organization: null })
  api.runs.mockResolvedValue([])
  getAgents.mockResolvedValue([])
})

describe('EnvironmentNewPage', () => {
  it('creates the environment and opens its page', async () => {
    api.create.mockResolvedValue({ id: 'new-env' })
    const user = userEvent.setup()
    render(<EnvironmentNewPage />)
    await user.type(await screen.findByLabelText('Name'), 'web-app')
    await user.click(screen.getByRole('button', { name: 'Create environment' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'web-app', image: { base: 'standard' }, visibility: 'private' })))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/runners/hosted/new-env'))
  })

  it('shows what the server refuses, in its words', async () => {
    api.create.mockRejectedValue({ response: { data: { error: { message: 'An environment named web-app already exists' } } } })
    const user = userEvent.setup()
    render(<EnvironmentNewPage />)
    await user.type(await screen.findByLabelText('Name'), 'web-app')
    await user.click(screen.getByRole('button', { name: 'Create environment' }))
    await waitFor(() => expect(notes.error).toHaveBeenCalled())
    expect(navigate).not.toHaveBeenCalled()
  })

  it('has no form when hosted machines are off', async () => {
    api.list.mockResolvedValue({ success: true, data: [], enabled: false })
    render(<EnvironmentNewPage />)
    expect(await screen.findByText(/Hosted machines aren't available on this server/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('offers no form when the server sends no settings to choose from', async () => {
    api.list.mockResolvedValue({ success: true, data: [], enabled: true })
    render(<EnvironmentNewPage />)
    expect(await screen.findByTestId('hosted-settings-missing')).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })
})

describe('EnvironmentDetailPage', () => {
  it('shows its minutes this month and its recent runs', async () => {
    api.usage.mockResolvedValue({ from: '', to: '', environments: [{ environmentId: 'e1', name: 'web-app', minutes: 95, byClass: {} }], organization: null })
    api.runs.mockResolvedValue([
      { id: 'r1', kind: 'run', agentId: 'a1', agentName: 'repo-helper', status: 'completed', userId: 'me', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'x1', kind: 'execution', agentId: 'a2', agentName: 'nightly-build', status: 'failed', userId: 'me', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ])
    render(<EnvironmentDetailPage />)
    expect(await screen.findByTestId('environment-usage')).toHaveTextContent('Ran 1 h 35 min this month')
    const runs = await screen.findByTestId('environment-runs')
    expect(await within(runs).findByRole('link', { name: /repo-helper/ })).toHaveAttribute('href', '/agents/a1?tab=runs')
    expect(within(runs).getByText('completed')).toBeInTheDocument()
    expect(within(runs).getByText('failed')).toBeInTheDocument()
    expect(api.runs).toHaveBeenCalledWith('e1', 10)
  })

  it('says when no run has used it yet', async () => {
    render(<EnvironmentDetailPage />)
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument()
  })

  it('shows a machine kept from a member who left as read-only, in plain words', async () => {
    api.workspaces.mockResolvedValue([
      running,
      { ...running, id: 'w9', readOnly: true, inheritedFromUserId: 'gone', status: 'suspended', machine: { ...running.machine, state: 'suspended', desired: { replicas: 0 } } },
    ])
    render(<EnvironmentDetailPage />)
    const machines = await screen.findByTestId('environment-machines')
    expect(await within(machines).findByText('Kept for you from a member who left')).toBeInTheDocument()
    expect(within(machines).getByText('read-only')).toBeInTheDocument()
    expect(within(machines).getByTestId('inherited-note')).toHaveTextContent(/copy what you need, then release it/)
  })

  it('tells a machine nothing asked for yet from one that is starting', async () => {
    api.workspaces.mockResolvedValue([{ ...running, status: 'suspended', machine: { ...running.machine, state: 'pending', desired: { replicas: 0 } } }])
    render(<EnvironmentDetailPage />)
    const machines = await screen.findByTestId('environment-machines')
    expect(await within(machines).findByText('not started')).toBeInTheDocument()
    expect(within(machines).queryByRole('button', { name: 'Suspend' })).toBeNull()
  })

  it('shows the running machine and parks it with Suspend', async () => {
    api.workspaces.mockResolvedValue([running])
    api.suspend.mockResolvedValue({})
    const user = userEvent.setup()
    render(<EnvironmentDetailPage />)
    const machines = await screen.findByTestId('environment-machines')
    expect(await within(machines).findByText('running')).toBeInTheDocument()
    expect(within(machines).getByText('You')).toBeInTheDocument()
    await user.click(within(machines).getByRole('button', { name: 'Suspend' }))
    await waitFor(() => expect(api.suspend).toHaveBeenCalledWith('e1', 'w1'))
  })

  it('releases a workspace only after the one-line confirm', async () => {
    api.workspaces.mockResolvedValue([{ ...running, status: 'suspended', machine: { ...running.machine, state: 'suspended' } }])
    api.release.mockResolvedValue({})
    const user = userEvent.setup()
    render(<EnvironmentDetailPage />)
    const machines = await screen.findByTestId('environment-machines')
    expect(await within(machines).findByText('parked')).toBeInTheDocument()
    expect(within(machines).queryByRole('button', { name: 'Suspend' })).toBeNull()
    await user.click(within(machines).getByRole('button', { name: 'Release' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Release this workspace and delete its files?')).toBeInTheDocument()
    expect(api.release).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Release' }))
    await waitFor(() => expect(api.release).toHaveBeenCalledWith('e1', 'w1'))
  })

  it("names other people's machines for an admin and shows why one failed", async () => {
    role.canManage = true
    api.workspaces.mockResolvedValue([{ ...running, id: 'w2', ownerUserId: 'them', machine: { ...running.machine, state: 'failed', lastError: 'The image could not be pulled' } }])
    render(<EnvironmentDetailPage />)
    expect(await screen.findByText('Sam Rivera')).toBeInTheDocument()
    expect(screen.getByText('Machines')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('The image could not be pulled')).toBeInTheDocument()
  })

  it('lists the agents that run on it', async () => {
    getAgents.mockResolvedValue([{ id: 'a1', name: 'repo-helper', agentConfig: { environmentId: 'e1' } }, { id: 'a2', name: 'elsewhere', agentConfig: {} }])
    render(<EnvironmentDetailPage />)
    expect(await screen.findByRole('link', { name: 'repo-helper' })).toHaveAttribute('href', '/agents/a1')
    expect(screen.queryByText('elsewhere')).toBeNull()
  })

  it('saves settings in place', async () => {
    api.update.mockResolvedValue(ENV)
    const user = userEvent.setup()
    render(<EnvironmentDetailPage />)
    const idle = await screen.findByLabelText('Park after')
    await user.clear(idle)
    await user.type(idle, '45')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('e1', expect.objectContaining({ idleTimeoutMinutes: 45 })))
  })

  it('deletes after the confirm and goes back to the Hosted tab', async () => {
    api.remove.mockResolvedValue({})
    const user = userEvent.setup()
    render(<EnvironmentDetailPage />)
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Delete environment web-app\?/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('e1'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/runners?tab=hosted'))
  })

  it("is read-only for someone who neither owns it nor administers the organization", async () => {
    api.getById.mockResolvedValue({ ...ENV, ownerUserId: 'them', visibility: 'org' })
    render(<EnvironmentDetailPage />)
    expect(await screen.findByText('Only its owner or an organization admin can change it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })
})
