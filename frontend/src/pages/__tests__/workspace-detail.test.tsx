import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { WorkspaceDetailPage } from '../workspace-detail'

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useParams: () => ({ id: 'ws-1' }) }
})

vi.mock('../../lib/api', () => ({
  workspacesApi: {
    getById: vi.fn(),
    release: vi.fn(),
  },
}))
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'o1' } }),
}))
vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import { workspacesApi } from '../../lib/api'
const getById = workspacesApi.getById as ReturnType<typeof vi.fn>
const release = workspacesApi.release as ReturnType<typeof vi.fn>

describe('WorkspaceDetailPage', () => {
  beforeEach(() => {
    getById.mockReset()
    release.mockReset()
  })

  it('shows close reason for stranded workspaces and hides it for active ones', async () => {
    getById.mockResolvedValue(makeWorkspace({
      status: 'stranded',
      closeReason: { kind: 'stranded', detail: 'r-old' },
      closedAt: new Date().toISOString(),
    }))
    const { unmount } = render(<WorkspaceDetailPage />)
    await waitFor(() => expect(screen.getByText(/close reason/i)).toBeInTheDocument())
    expect(screen.getByText('r-old')).toBeInTheDocument()
    expect(screen.getByText(/Stranded means the runner pinned/i)).toBeInTheDocument()
    unmount()

    getById.mockResolvedValue(makeWorkspace({ status: 'active' }))
    render(<WorkspaceDetailPage />)
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument())
    expect(screen.queryByText(/close reason/i)).toBeNull()
  })

  it('Release button only renders for active workspaces and triggers a confirm dialog', async () => {
    getById.mockResolvedValue(makeWorkspace({ status: 'active' }))
    release.mockResolvedValue({})
    const user = userEvent.setup()
    render(<WorkspaceDetailPage />)
    await waitFor(() => screen.getByRole('button', { name: /release workspace/i }))

    await user.click(screen.getByRole('button', { name: /release workspace/i }))
    await waitFor(() => screen.getByText(/release this workspace\?/i))

    // Dialog action button label is "Release"; the original is
    // "Release workspace". Use the dialog scope to pick the right one.
    const buttons = screen.getAllByRole('button', { name: /^release$/i })
    await user.click(buttons[buttons.length - 1])
    await waitFor(() => expect(release).toHaveBeenCalledWith('ws-1'))
  })

  it('Release button is hidden for terminal statuses', async () => {
    for (const status of ['released', 'expired', 'stranded'] as const) {
      getById.mockResolvedValue(makeWorkspace({ status, closedAt: new Date().toISOString() }))
      const { unmount } = render(<WorkspaceDetailPage />)
      await waitFor(() => screen.getByText(status))
      expect(screen.queryByRole('button', { name: /release workspace/i })).toBeNull()
      unmount()
    }
  })
})

function makeWorkspace(overrides: Partial<any>): any {
  return {
    id: 'ws-1',
    runnerId: 'r1',
    ownerUserId: 'u1',
    cwd: '/work',
    isolation: 'host',
    status: 'active',
    ttlAt: null,
    closeReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    ...overrides,
  }
}
