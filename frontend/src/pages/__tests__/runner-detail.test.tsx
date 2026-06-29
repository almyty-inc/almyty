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
  },
  workspacesApi: {
    getAll: vi.fn(),
  },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'o1', name: 'Org' } }),
}))
vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import { runnersApi, workspacesApi } from '../../lib/api'

const getRunner = runnersApi.getById as ReturnType<typeof vi.fn>
const getWorkspaces = workspacesApi.getAll as ReturnType<typeof vi.fn>
const unregister = runnersApi.unregister as ReturnType<typeof vi.fn>

describe('RunnerDetailPage', () => {
  beforeEach(() => {
    getRunner.mockReset()
    getWorkspaces.mockReset()
    unregister.mockReset()
    getWorkspaces.mockResolvedValue([])
  })

  it('renders runtime info and labels', async () => {
    getRunner.mockResolvedValue(makeRunner({ name: 'mac-laptop', state: 'online', labels: { env: 'dev' } }))
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('mac-laptop')).toBeInTheDocument())
    expect(screen.getByText('darwin / arm64')).toBeInTheDocument()
    expect(screen.getByText('env=dev')).toBeInTheDocument()
  })

  it('shows the Deregister button only when the runner is offline', async () => {
    getRunner.mockResolvedValue(makeRunner({ state: 'online' }))
    const { rerender, unmount } = render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('online')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /deregister/i })).toBeNull()

    unmount()
    getRunner.mockResolvedValue(makeRunner({ state: 'offline' }))
    render(<RunnerDetailPage />)
    await waitFor(() => expect(screen.getByText('offline')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /deregister/i })).toBeInTheDocument()
  })

  it('Deregister button opens a confirmation dialog and calls the API on confirm', async () => {
    getRunner.mockResolvedValue(makeRunner({ state: 'offline' }))
    unregister.mockResolvedValue({})
    const user = userEvent.setup()
    render(<RunnerDetailPage />)
    await waitFor(() => screen.getByRole('button', { name: /deregister/i }))
    await user.click(screen.getByRole('button', { name: /deregister/i }))
    // Confirmation dialog
    await waitFor(() => screen.getByText(/deregister this runner\?/i))
    // The dialog cancel + confirm both have "Deregister" labels; the
    // last one in the document is the AlertDialogAction.
    const buttons = screen.getAllByRole('button', { name: /deregister/i })
    await user.click(buttons[buttons.length - 1])
    await waitFor(() => expect(unregister).toHaveBeenCalledWith('r1'))
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
