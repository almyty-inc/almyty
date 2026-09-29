/**
 * Workspaces live on their runner's page: a Workspaces tab lists that
 * runner's workspaces (active first) in the shared table, each row opens
 * the workspace under the runner, and the old /workspaces addresses land
 * on the runner (or on Runners when the workspace is gone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import { RunnerWorkspacesTab, runnerWorkspaces, timeLeft, workspacePath } from '../runner-workspaces-tab'
import { WorkspaceAddressRedirect, WorkspaceDetailPage } from '../../../pages/workspace-detail'
import { workspacesApi } from '../../../lib/api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('../../../lib/api', () => ({
  workspacesApi: { getAll: vi.fn(), getById: vi.fn(), release: vi.fn() },
}))
vi.mock('../../../store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

function workspace(overrides: Partial<any> = {}): any {
  return {
    id: 'ws-1',
    runnerId: 'r1',
    cwd: '/work',
    isolation: 'host',
    status: 'active',
    ttlAt: null,
    closeReason: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('a runner\'s Workspaces tab', () => {
  it('lists this runner\'s workspaces only, active first, in the shared table', async () => {
    vi.mocked(workspacesApi.getAll).mockResolvedValue([
      workspace({ id: 'ws-old', cwd: '/released', status: 'released', closeReason: { kind: 'released', detail: '' }, createdAt: '2026-09-25T00:00:00.000Z' }),
      workspace({ id: 'ws-live', cwd: '/active' }),
      workspace({ id: 'ws-other', runnerId: 'r2', cwd: '/elsewhere' }),
    ])
    renderAtRoute(<RunnerWorkspacesTab runnerId="r1" poll={false} />, { path: '/runners/r1' })
    const table = await screen.findByTestId('runner-workspaces')
    await within(table).findByText('/active')
    const rows = within(table).getAllByRole('row').slice(1).map((r) => r.textContent)
    expect(rows[0]).toContain('/active')
    expect(rows[1]).toContain('/released')
    expect(rows[1]).toContain('closed: released')
    expect(within(table).queryByText('/elsewhere')).toBeNull()
  })

  it('opens a workspace under its runner', async () => {
    vi.mocked(workspacesApi.getAll).mockResolvedValue([workspace()])
    const { router } = renderAtRoute(<RunnerWorkspacesTab runnerId="r1" poll={false} />, { path: '/runners/r1', paths: ['/runners/:runnerId/workspaces/:id'] })
    fireEvent.click((await screen.findByText('/work')).closest('tr')!)
    await waitFor(() => expect(router.state.location.pathname).toBe('/runners/r1/workspaces/ws-1'))
  })

  it('says agents make workspaces when there are none', async () => {
    vi.mocked(workspacesApi.getAll).mockResolvedValue([])
    renderAtRoute(<RunnerWorkspacesTab runnerId="r1" poll={false} />, { path: '/runners/r1' })
    expect(await screen.findByText('No workspaces yet')).toBeInTheDocument()
    expect(screen.getByText(/You don't create them by hand/)).toBeInTheDocument()
  })
})

describe('a workspace page under its runner', () => {
  it('goes back to the runner\'s Workspaces tab', async () => {
    vi.mocked(workspacesApi.getById).mockResolvedValue(workspace())
    renderAtRoute(<WorkspaceDetailPage />, { path: '/runners/:runnerId/workspaces/:id', url: '/runners/r1/workspaces/ws-1' })
    expect(await screen.findByRole('link', { name: 'Workspaces' })).toHaveAttribute('href', '/runners/r1?tab=workspaces')
  })

  it('moves an address with the wrong runner to the right one', async () => {
    vi.mocked(workspacesApi.getById).mockResolvedValue(workspace({ runnerId: 'r2' }))
    const { router } = renderAtRoute(<WorkspaceDetailPage />, { path: '/runners/:runnerId/workspaces/:id', url: '/runners/r1/workspaces/ws-1' })
    await waitFor(() => expect(router.state.location.pathname).toBe('/runners/r2/workspaces/ws-1'))
  })
})

describe('the old /workspaces addresses', () => {
  it('send a workspace to its runner', async () => {
    vi.mocked(workspacesApi.getById).mockResolvedValue(workspace({ runnerId: 'r7' }))
    const { router } = renderAtRoute(<WorkspaceAddressRedirect />, { path: '/workspaces/:id', url: '/workspaces/ws-1', paths: ['/runners/:runnerId/workspaces/:id'] })
    await waitFor(() => expect(router.state.location.pathname).toBe('/runners/r7/workspaces/ws-1'))
  })

  it('send a workspace that is gone to Runners', async () => {
    vi.mocked(workspacesApi.getById).mockRejectedValue(new Error('404'))
    const { router } = renderAtRoute(<WorkspaceAddressRedirect />, { path: '/workspaces/:id', url: '/workspaces/nope', paths: ['/runners'] })
    await waitFor(() => expect(router.state.location.pathname).toBe('/runners'))
  })
})

describe('helpers', () => {
  it('says how long a time limit has left, never "just now" for a future one', () => {
    const now = Date.parse('2026-09-29T12:00:00.000Z')
    expect(timeLeft('2026-09-29T15:00:00.000Z', now)).toBe('in 3h')
    expect(timeLeft('2026-09-29T12:50:00.000Z', now)).toBe('in 50m')
    expect(timeLeft('2026-10-03T12:00:00.000Z', now)).toBe('in 4d')
    expect(timeLeft('2026-09-29T11:00:00.000Z', now)).toBe('now')
  })

  it('puts a workspace under its runner', () => {
    expect(workspacePath({ id: 'ws 1', runnerId: 'r1' })).toBe('/runners/r1/workspaces/ws%201')
  })

  it('keeps one runner\'s workspaces, active first, then newest', () => {
    const list = runnerWorkspaces(
      [
        workspace({ id: 'a', status: 'released', createdAt: '2026-09-03T00:00:00.000Z' }),
        workspace({ id: 'b', status: 'active', createdAt: '2026-09-01T00:00:00.000Z' }),
        workspace({ id: 'c', status: 'expired', createdAt: '2026-09-04T00:00:00.000Z' }),
        workspace({ id: 'd', runnerId: 'r2' }),
      ],
      'r1',
    )
    expect(list.map((w) => w.id)).toEqual(['b', 'c', 'a'])
  })
})
