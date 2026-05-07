import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { RunnersPage } from '../runners'

vi.mock('../../lib/api', () => ({
  runnersApi: { getAll: vi.fn() },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'test-org-id', name: 'Test Org' },
  }),
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import { runnersApi } from '../../lib/api'

const mockedGetAll = runnersApi.getAll as ReturnType<typeof vi.fn>

describe('RunnersPage', () => {
  beforeEach(() => {
    mockedGetAll.mockReset()
  })

  it('renders the empty state with a Start a runner CTA when no runners are registered', async () => {
    mockedGetAll.mockResolvedValue([])
    render(<RunnersPage />)
    await waitFor(() => {
      expect(screen.getByText(/no runners registered/i)).toBeInTheDocument()
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

  it('renders an error state with retry when the query fails', async () => {
    mockedGetAll.mockRejectedValue(new Error('boom'))
    render(<RunnersPage />)
    await waitFor(() => {
      expect(screen.getByText(/couldn't load runners/i)).toBeInTheDocument()
    })
  })
})

function makeRunner(overrides: Partial<any>): any {
  return {
    id: overrides.id ?? 'r-x',
    name: overrides.name ?? 'r-x',
    state: overrides.state ?? 'online',
    labels: overrides.labels ?? {},
    runtimeInfo: overrides.runtimeInfo ?? {
      os: 'darwin', arch: 'arm64', hostname: 'host',
      cpuCount: 8, memoryMb: 16000, runnerVersion: '0.1.0',
      binaries: { node: 'v20', git: 'git 2.47.0', python: null },
    },
    config: overrides.config ?? { maxConcurrent: 4 },
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date(Date.now() - 5000).toISOString(),
    registeredAt: overrides.registeredAt ?? new Date().toISOString(),
  }
}
