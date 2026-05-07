import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { WorkspacesPage } from '../workspaces'

vi.mock('../../lib/api', () => ({
  runnersApi: { getAll: vi.fn() },
  workspacesApi: { getAll: vi.fn() },
}))
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'o1', name: 'Org' } }),
}))
vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import { runnersApi, workspacesApi } from '../../lib/api'
const wsGetAll = workspacesApi.getAll as ReturnType<typeof vi.fn>
const runnersGetAll = runnersApi.getAll as ReturnType<typeof vi.fn>

describe('WorkspacesPage', () => {
  beforeEach(() => {
    wsGetAll.mockReset()
    runnersGetAll.mockReset()
    runnersGetAll.mockResolvedValue([{ id: 'r1', name: 'mac-laptop' }])
  })

  it('shows the empty state when no workspaces exist', async () => {
    wsGetAll.mockResolvedValue([])
    render(<WorkspacesPage />)
    await waitFor(() => expect(screen.getByText(/no workspaces yet/i)).toBeInTheDocument())
  })

  it('defaults to active filter only and excludes terminated rows', async () => {
    wsGetAll.mockResolvedValue([
      makeWorkspace({ id: 'a', cwd: '/active', status: 'active' }),
      makeWorkspace({ id: 'b', cwd: '/released', status: 'released' }),
      makeWorkspace({ id: 'c', cwd: '/stranded', status: 'stranded' }),
    ])
    render(<WorkspacesPage />)
    await waitFor(() => expect(screen.getByText('/active')).toBeInTheDocument())
    expect(screen.queryByText('/released')).toBeNull()
    expect(screen.queryByText('/stranded')).toBeNull()
  })

  it('toggles status filter to include released rows when the chip is clicked', async () => {
    wsGetAll.mockResolvedValue([
      makeWorkspace({ id: 'a', cwd: '/active', status: 'active' }),
      makeWorkspace({ id: 'b', cwd: '/released', status: 'released' }),
    ])
    const user = userEvent.setup()
    render(<WorkspacesPage />)
    await waitFor(() => screen.getByText('/active'))
    expect(screen.queryByText('/released')).toBeNull()
    // Clicking the "released" chip toggles it on.
    const chip = screen.getByRole('button', { name: 'released' })
    await user.click(chip)
    await waitFor(() => expect(screen.getByText('/released')).toBeInTheDocument())
  })

  it('search input filters by cwd substring', async () => {
    wsGetAll.mockResolvedValue([
      makeWorkspace({ id: 'a', cwd: '/work/projectA', status: 'active' }),
      makeWorkspace({ id: 'b', cwd: '/work/projectB', status: 'active' }),
    ])
    const user = userEvent.setup()
    render(<WorkspacesPage />)
    await waitFor(() => screen.getByText('/work/projectA'))
    await user.type(screen.getByPlaceholderText(/filter by cwd/i), 'projectB')
    await waitFor(() => {
      expect(screen.queryByText('/work/projectA')).toBeNull()
      expect(screen.getByText('/work/projectB')).toBeInTheDocument()
    })
  })
})

function makeWorkspace(overrides: Partial<any>): any {
  return {
    id: 'ws',
    runnerId: 'r1',
    cwd: '/work',
    isolation: 'host',
    status: 'active',
    ttlAt: null,
    closeReason: overrides.status && overrides.status !== 'active'
      ? { kind: overrides.status, detail: '' }
      : null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}
