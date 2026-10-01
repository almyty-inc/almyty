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
import { WorkspaceDetailPage } from '../../../pages/workspace-detail'
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
    expect(screen.getByText(/gets one here automatically/)).toBeInTheDocument()
    expect(screen.getByText(/You don't create them by hand/)).toBeInTheDocument()
  })

  it('names the agent and run a workspace was made for, linking to the agent\'s runs', async () => {
    vi.mocked(workspacesApi.getAll).mockResolvedValue([
      workspace({ id: 'ws-auto', cwd: '/home/me/.almyty/workspaces/support-bot-aaaabbbb', agentId: 'agent-1', runId: 'aaaabbbb-1111-4111-8111-111111111111', agent: { id: 'agent-1', name: 'Support Bot' } }),
      workspace({ id: 'ws-api', cwd: '/api-made' }),
      workspace({ id: 'ws-orphan', cwd: '/orphan', agentId: null, runId: 'ccccdddd-2222-4222-8222-222222222222', agent: null }),
    ])
    renderAtRoute(<RunnerWorkspacesTab runnerId="r1" poll={false} />, { path: '/runners/r1' })
    const table = await screen.findByTestId('runner-workspaces')
    const link = await within(table).findByRole('link', { name: 'Support Bot' })
    expect(link).toHaveAttribute('href', '/agents/agent-1?tab=runs')
    const autoRow = link.closest('tr')!
    expect(autoRow).toHaveTextContent('run aaaabbbb')
    expect(within(table).getByText('/api-made').closest('tr')).toHaveTextContent('API')
    expect(within(table).getByText('/orphan').closest('tr')).toHaveTextContent('deleted agent')
  })

  it('releases an active workspace from its row after confirming, without opening it', async () => {
    vi.mocked(workspacesApi.getAll).mockResolvedValue([
      workspace({ id: 'ws-live', cwd: '/active' }),
      workspace({ id: 'ws-done', cwd: '/released', status: 'released', closeReason: { kind: 'released', detail: '' } }),
    ])
    vi.mocked(workspacesApi.release).mockResolvedValue({ id: 'ws-live', status: 'released' } as any)
    const { router } = renderAtRoute(<RunnerWorkspacesTab runnerId="r1" poll={false} />, { path: '/runners/r1', paths: ['/runners/:runnerId/workspaces/:id'] })
    const table = await screen.findByTestId('runner-workspaces')
    await within(table).findByText('/active')

    // Only the active one can be released.
    const buttons = within(table).getAllByRole('button', { name: 'Release' })
    expect(buttons).toHaveLength(1)
    expect(within(table).getByText('/active').closest('tr')).toContainElement(buttons[0])

    fireEvent.click(buttons[0])
    expect(workspacesApi.release).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Release workspace' }))

    await waitFor(() => expect(workspacesApi.release).toHaveBeenCalledWith('ws-live'))
    expect(router.state.location.pathname).toBe('/runners/r1')
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
