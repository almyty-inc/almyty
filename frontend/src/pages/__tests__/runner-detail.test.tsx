import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { RunnerDetailPage } from '../runner-detail'

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useParams: () => ({ id: 'r1' }) }
})

vi.mock('../../lib/api', () => ({
  runnersApi: {
    getById: vi.fn(),
    unregister: vi.fn(),
    update: vi.fn(),
  },
  workspacesApi: {
    getAll: vi.fn(),
  },
  organizationsApi: {
    getTeams: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'o1', name: 'Org' } }),
}))
vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))
vi.mock('../../store/auth', () => ({
  useAuthStore: () => ({ user: { id: 'me' } }),
}))

import { runnersApi, workspacesApi } from '../../lib/api'

const getRunner = runnersApi.getById as ReturnType<typeof vi.fn>
const getWorkspaces = workspacesApi.getAll as ReturnType<typeof vi.fn>
const unregister = runnersApi.unregister as ReturnType<typeof vi.fn>
const update = runnersApi.update as ReturnType<typeof vi.fn>

describe('RunnerDetailPage', () => {
  beforeEach(() => {
    getRunner.mockReset()
    getWorkspaces.mockReset()
    unregister.mockReset()
    update.mockReset()
    getWorkspaces.mockResolvedValue([])
  })

  it('renders runtime info and labels', async () => {
    getRunner.mockResolvedValue(makeRunner({ name: 'mac-laptop', state: 'online', labels: { env: 'dev' } }))
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('mac-laptop')).toBeInTheDocument())
    expect(screen.getByText('darwin / arm64')).toBeInTheDocument()
    expect(screen.getByText('env=dev')).toBeInTheDocument()
  })

  it('offers Delete only for an offline runner or one that never connected', async () => {
    getRunner.mockResolvedValue(makeRunner({ state: 'online' }))
    const { unmount } = render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('online')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /delete runner/i })).toBeNull()
    unmount()

    getRunner.mockResolvedValue(makeRunner({ state: 'offline' }))
    const second = render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('offline')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /delete runner/i })).toBeInTheDocument()
    second.unmount()

    // The setup page's record, abandoned before the daemon ever started.
    getRunner.mockResolvedValue(makeRunner({ state: 'registered', runtimeInfo: null, lastHeartbeatAt: null }))
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('never connected')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /delete runner/i })).toBeInTheDocument()
    expect(screen.getByText('almyty-runner start --name r1 --org o1')).toBeInTheDocument()
  })

  it('Delete asks a one-line confirmation and calls the API on confirm', async () => {
    getRunner.mockResolvedValue(makeRunner({ state: 'offline' }))
    unregister.mockResolvedValue({})
    const user = userEvent.setup()
    render(<RunnerDetailPage />)
    await user.click(await screen.findByRole('button', { name: /delete runner/i }))
    await waitFor(() => screen.getByText(/delete runner r1\?/i))
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(unregister).toHaveBeenCalledWith('r1'))
  })

  it('lets the owner change visibility in place, without a dialog', async () => {
    getRunner.mockResolvedValue(makeRunner({ ownerUserId: 'me', visibility: 'org' }))
    update.mockResolvedValue({})
    const user = userEvent.setup()
    render(<RunnerDetailPage />)
    await user.click(await screen.findByRole('radio', { name: /private/i }))
    await user.click(screen.getByRole('button', { name: /save visibility/i }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('r1', { visibility: 'private', teamId: null }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not offer the visibility editor to someone who does not own the runner', async () => {
    getRunner.mockResolvedValue(makeRunner({ ownerUserId: 'someone-else', visibility: 'org' }))
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('darwin / arm64')).toBeInTheDocument())
    expect(screen.queryByText(/who can see and use it/i)).toBeNull()
  })
  it('renders detected coding agents with provider + capability badges', async () => {
    getRunner.mockResolvedValue(makeRunner({
      runtimeInfo: {
        os: 'darwin', arch: 'arm64', hostname: 'host',
        cpuCount: 8, memoryMb: 16000, runnerVersion: '0.1.0',
        binaries: { node: 'v20' },
        codingAgents: [
          { id: 'claude', displayName: 'Claude Code', version: '1.2.3', providerFamily: 'anthropic', supportsMcp: true, canManage: true },
          { id: 'codex', displayName: 'Codex', version: '0.9', providerFamily: 'openai', supportsMcp: true, canManage: true },
        ],
      },
    }))
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument())
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
    expect(screen.getByText('openai')).toBeInTheDocument()
  })

  it('shows an empty hint when no coding agents are detected', async () => {
    getRunner.mockResolvedValue(makeRunner({ state: 'online' })) // no codingAgents
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText(/no coding agents detected/i)).toBeInTheDocument())
  })

  it('lists active workspaces with a link to workspace detail', async () => {
    getRunner.mockResolvedValue(makeRunner({ state: 'busy' }))
    getWorkspaces.mockResolvedValue([
      makeWorkspace({ id: 'ws-aaaaaaaa-1111-2222', runnerId: 'r1', status: 'active', cwd: '/foo/bar' }),
      makeWorkspace({ id: 'ws-bbbbbbbb-3333-4444', runnerId: 'r1', status: 'released', cwd: '/baz' }),
    ])
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('Active workspaces (1)')).toBeInTheDocument())
    expect(screen.getByText('/foo/bar')).toBeInTheDocument()
    // Released workspace shown in "Recent" section, not "Active".
    expect(screen.getByText('/baz')).toBeInTheDocument()
  })
})

function makeRunner(overrides: Partial<any>): any {
  return {
    id: 'r1',
    name: 'r1',
    state: 'online',
    labels: {},
    runtimeInfo: {
      os: 'darwin', arch: 'arm64', hostname: 'host',
      cpuCount: 8, memoryMb: 16000, runnerVersion: '0.1.0',
      binaries: { node: 'v20', git: 'git 2.47.0', python: null },
    },
    config: { maxConcurrent: 4 },
    lastHeartbeatAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeWorkspace(overrides: Partial<any>): any {
  return {
    id: overrides.id ?? 'ws-1',
    runnerId: overrides.runnerId ?? 'r1',
    cwd: overrides.cwd ?? '/work',
    isolation: 'host',
    status: overrides.status ?? 'active',
    ttlAt: null,
    closeReason: overrides.status && overrides.status !== 'active'
      ? { kind: overrides.status, detail: '' }
      : null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}
