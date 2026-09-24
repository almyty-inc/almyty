import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { WorkspaceDetailPage } from '../workspace-detail'
import { RunnerDetailPage } from '../runner-detail'
import { workspacesApi, runnersApi, toolsApi } from '../../lib/api'

// Both detail pages used a bare refetchInterval, so a workspace in a
// terminal state (released, expired, stranded -- "stranded = stranded",
// there is no migration back) and a runner that had gone offline (the
// FSM has no edge out of it) kept being polled for as long as the tab
// stayed open.

vi.mock('../../lib/api', () => ({
  workspacesApi: { getById: vi.fn(), getAll: vi.fn(), release: vi.fn() },
  runnersApi: { getById: vi.fn(), delete: vi.fn(), deregister: vi.fn() },
  toolsApi: { getAll: vi.fn() },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({ id: 'x1' }),
    useLocation: () => ({ pathname: '/x/x1', search: '', hash: '', state: null }),
  }
})

const WORKSPACE = (status: string) => ({
  id: 'x1',
  runnerId: 'r1',
  ownerUserId: 'u1',
  cwd: '/srv/app',
  isolation: 'container',
  status,
  ttlAt: null,
  closeReason: status === 'stranded' ? { kind: 'stranded', detail: 'r1' } : null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: status === 'active' ? null : '2026-01-02T00:00:00.000Z',
})

const RUNNER = (state: string) => ({
  id: 'x1',
  name: 'mac-mini',
  state,
  labels: {},
  runtimeInfo: null,
  config: { maxConcurrent: 2 },
  lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
  registeredAt: '2026-01-01T00:00:00.000Z',
})

const POLL_MS = 15_000

describe('terminal records stop being polled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.mocked(workspacesApi.getAll).mockResolvedValue([] as any)
    vi.mocked(toolsApi.getAll).mockResolvedValue([] as any)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['released', 'expired', 'stranded'])(
    'stops polling a %s workspace',
    async (status) => {
      vi.mocked(workspacesApi.getById).mockResolvedValue(WORKSPACE(status) as any)

      render(<WorkspaceDetailPage />)
      await waitFor(() => expect(workspacesApi.getById).toHaveBeenCalledTimes(1))

      await vi.advanceTimersByTimeAsync(POLL_MS * 6)
      expect(workspacesApi.getById).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps polling an active workspace', async () => {
    vi.mocked(workspacesApi.getById).mockResolvedValue(WORKSPACE('active') as any)

    render(<WorkspaceDetailPage />)
    await waitFor(() => expect(workspacesApi.getById).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(workspacesApi.getById.mock.calls.length).toBeGreaterThan(1)
  })

  it('stops polling a runner that has gone offline', async () => {
    vi.mocked(runnersApi.getById).mockResolvedValue(RUNNER('offline') as any)

    render(<RunnerDetailPage />)
    await waitFor(() => expect(runnersApi.getById).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(POLL_MS * 6)
    expect(runnersApi.getById).toHaveBeenCalledTimes(1)
    // Its workspaces are all stranded by then, so that poll stops too.
    const workspaceCalls = vi.mocked(workspacesApi.getAll).mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(vi.mocked(workspacesApi.getAll).mock.calls.length).toBe(workspaceCalls)
  })

  it('keeps polling a runner that is online', async () => {
    vi.mocked(runnersApi.getById).mockResolvedValue(RUNNER('online') as any)

    render(<RunnerDetailPage />)
    await waitFor(() => expect(runnersApi.getById).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(runnersApi.getById.mock.calls.length).toBeGreaterThan(1)
  })
})
