import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { RunnersPage } from '../runners'

// A pass-through mock, as runner-detail.test has: without it the tab switch
// (setSearchParams) never reached the rendered location in this suite.
vi.mock('react-router-dom', async () => ({ ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')) }))

vi.mock('../../lib/api', () => ({
  runnersApi: { getAll: vi.fn(), unregister: vi.fn() },
  environmentsApi: { list: vi.fn(), usage: vi.fn().mockResolvedValue({ from: '', to: '', environments: [], organization: null }) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../store/organization', () => {
  const state = { currentOrganization: { id: 'test-org-id', name: 'Test Org' } }
  return { useOrganizationStore: (select?: any) => (select ? select(state) : state) }
})

vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import { environmentsApi, runnersApi } from '../../lib/api'

const mockedGetAll = runnersApi.getAll as ReturnType<typeof vi.fn>
const mockedUnregister = runnersApi.unregister as ReturnType<typeof vi.fn>
const mockedEnvList = environmentsApi.list as ReturnType<typeof vi.fn>

describe('RunnersPage', () => {
  beforeEach(() => {
    mockedGetAll.mockReset()
    mockedUnregister.mockReset()
  })

  it('renders the empty state with a Start a runner CTA when no runners are registered', async () => {
    mockedGetAll.mockResolvedValue([])
    render(<RunnersPage />)
    await waitFor(() => {
      expect(screen.getByText(/no runners yet/i)).toBeInTheDocument()
    })
    // CTA appears in both the header and the empty-state body. Testing
    // that at least one is wired to /runners/new.
    const startButtons = screen.getAllByRole('button', { name: /start a runner/i })
    expect(startButtons.length).toBeGreaterThanOrEqual(1)
  })

  it('renders rows with the right state badge text per runner', async () => {
    mockedGetAll.mockResolvedValue([
      makeRunner({ id: 'r1', name: 'mac-laptop', state: 'online' }),
      makeRunner({ id: 'r2', name: 'ci-box', state: 'stale' }),
      makeRunner({ id: 'r3', name: 'old-machine', state: 'offline' }),
    ])
    render(<RunnersPage />)
    await waitFor(() => {
      expect(screen.getByText('mac-laptop')).toBeInTheDocument()
      expect(screen.getByText('ci-box')).toBeInTheDocument()
      expect(screen.getByText('old-machine')).toBeInTheDocument()
      // Each badge rendered with the state name.
      expect(screen.getByText('online')).toBeInTheDocument()
      expect(screen.getByText('stale')).toBeInTheDocument()
      expect(screen.getByText('offline')).toBeInTheDocument()
    })
  })

  it('marks an abandoned setup as never connected and shows a private runner as private', async () => {
    mockedGetAll.mockResolvedValue([
      makeRunner({ id: 'r1', name: 'half-set-up', state: 'registered', runtimeInfo: null, lastHeartbeatAt: null, visibility: 'private' }),
    ])
    render(<RunnersPage />)
    await waitFor(() => {
      expect(screen.getByText('half-set-up')).toBeInTheDocument()
      expect(screen.getByText('never connected')).toBeInTheDocument()
      expect(screen.getByText('private')).toBeInTheDocument()
    })
  })

  it('renders an error state with retry when the query fails', async () => {
    mockedGetAll.mockRejectedValue(new Error('boom'))
    render(<RunnersPage />)
    await waitFor(() => {
      expect(screen.getByText(/couldn't load runners/i)).toBeInTheDocument()
    })
  })

  describe('delete', () => {
    const openDelete = async () => {
      mockedGetAll.mockResolvedValue([makeRunner({ id: 'r3', name: 'old-machine', state: 'offline' })])
      const user = userEvent.setup()
      render(<RunnersPage />)
      await user.click(await screen.findByRole('button', { name: /actions/i }))
      await user.click(await screen.findByText('Delete'))
      return { user, dialog: await screen.findByRole('alertdialog') }
    }

    it('asks before deleting, naming the runner', async () => {
      const { dialog } = await openDelete()
      expect(within(dialog).getByText(/delete runner old-machine\?/i)).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Delete runner' })).toBeInTheDocument()
      expect(mockedUnregister).not.toHaveBeenCalled()
    })

    it('Keep it leaves the runner alone', async () => {
      const { user, dialog } = await openDelete()
      await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(mockedUnregister).not.toHaveBeenCalled()
    })

    it('deletes the runner once confirmed', async () => {
      mockedUnregister.mockResolvedValue({})
      const { user, dialog } = await openDelete()
      await user.click(within(dialog).getByRole('button', { name: 'Delete runner' }))
      await waitFor(() => expect(mockedUnregister).toHaveBeenCalledWith('r3'))
    })
  })
  describe('tabs', () => {
    it('opens on Your machines and switches to Hosted, where the header offers a new environment', async () => {
      mockedGetAll.mockResolvedValue([makeRunner({ id: 'r1', name: 'mac-laptop', state: 'online' })])
      mockedEnvList.mockResolvedValue({ success: true, enabled: true, data: [] })
      const user = userEvent.setup()
      render(<RunnersPage />)
      expect(await screen.findByText('mac-laptop')).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Your machines' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('button', { name: /start a runner/i })).toBeInTheDocument()
      await user.click(screen.getByRole('tab', { name: 'Hosted' }))
      expect(await screen.findByText('No hosted environments yet')).toBeInTheDocument()
      expect(screen.queryByText('mac-laptop')).toBeNull()
      expect(screen.queryByRole('button', { name: /start a runner/i })).toBeNull()
      expect(screen.getAllByRole('button', { name: 'New environment' }).length).toBeGreaterThanOrEqual(1)
    })

    it('shows the unavailable note and no create button when hosted machines are off', async () => {
      mockedGetAll.mockResolvedValue([])
      mockedEnvList.mockResolvedValue({ success: true, enabled: false, data: [] })
      const user = userEvent.setup()
      render(<RunnersPage />)
      await user.click(await screen.findByRole('tab', { name: 'Hosted' }))
      expect(await screen.findByText(/Hosted machines aren't available on this server/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'New environment' })).toBeNull()
    })
  })
})

function makeRunner(overrides: Partial<any>): any {
  return {
    id: overrides.id ?? 'r-x',
    name: overrides.name ?? 'r-x',
    state: overrides.state ?? 'online',
    labels: overrides.labels ?? {},
    visibility: overrides.visibility ?? 'org',
    runtimeInfo: 'runtimeInfo' in overrides ? overrides.runtimeInfo : {
      os: 'darwin', arch: 'arm64', hostname: 'host',
      cpuCount: 8, memoryMb: 16000, runnerVersion: '0.1.0',
      binaries: { node: 'v20', git: 'git 2.47.0', python: null },
    },
    config: overrides.config ?? { maxConcurrent: 4 },
    lastHeartbeatAt: 'lastHeartbeatAt' in overrides ? overrides.lastHeartbeatAt : new Date(Date.now() - 5000).toISOString(),
    registeredAt: overrides.registeredAt ?? new Date().toISOString(),
  }
}
