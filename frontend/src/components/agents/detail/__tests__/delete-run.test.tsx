/**
 * "Delete run" on an opened run: offered to people who may manage the
 * agent, waits for a run still going, asks "Delete run?" first, and goes
 * back to a refreshed run list once the run is gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'

import { renderWithProviders } from '@/test/setup'
import { RunsTab } from '../runs-tab'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import { OrganizationRole, type AgentRun } from '@/types'

const deleteRun = vi.fn()
vi.mock('@/lib/api', () => ({
  promotedSkillsApi: { promote: vi.fn() },
  agentsApi: { deleteRun: (...args: unknown[]) => deleteRun(...args) },
}))
const notify = { success: vi.fn(), error: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    organizationId: 'org-1',
    mode: 'autonomous',
    status: 'completed',
    input: 'Reply with the single word: ready',
    thread: [],
    workingMemory: {},
    steps: [],
    currentStep: 1,
    maxSteps: 20,
    totalCost: 0,
    totalTokens: 0,
    executionTime: 0,
    createdAt: '2026-11-19T10:00:00Z',
    updatedAt: '2026-11-19T10:00:05Z',
    ...overrides,
  } as AgentRun
}

function signIn(userId: string, role: OrganizationRole) {
  useOrganizationStore.setState({ currentOrganization: { id: 'org-1', name: 'Northwind' } as any })
  useAuthStore.setState({
    user: { id: userId, organizationMemberships: [{ role, organization: { id: 'org-1' } }] } as any,
  })
}

function renderOpened(r: AgentRun, ownerUserId = 'user-owner') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  renderWithProviders(
    <RunsTab runs={[r, run({ id: 'run-2', createdAt: '2026-11-18T10:00:00Z' })]} agentId="agent-1" openRunId={r.id} ownerUserId={ownerUserId} />,
    { queryClient },
  )
  return { invalidate }
}

describe('Delete run', () => {
  beforeEach(() => {
    deleteRun.mockReset()
    notify.success.mockReset()
    notify.error.mockReset()
  })

  it('confirms, deletes the run, refreshes the list and goes back to it', async () => {
    signIn('user-admin', OrganizationRole.ADMIN)
    deleteRun.mockResolvedValue({ success: true })
    const { invalidate } = renderOpened(run())

    expect(screen.getByTestId('opened-run-run-1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete run' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete run?')
    expect(dialog).toHaveTextContent('It cannot be undone.')
    expect(deleteRun).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete run' }))

    await waitFor(() => expect(deleteRun).toHaveBeenCalledWith('agent-1', 'run-1'))
    await waitFor(() => expect(screen.queryByTestId('opened-run-run-1')).not.toBeInTheDocument())
    expect(screen.getByText('Runs')).toBeInTheDocument()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agent-runs', 'agent-1'] })
    expect(notify.success).toHaveBeenCalledWith('Run deleted')
  })

  it('does nothing when the confirm is cancelled', async () => {
    signIn('user-admin', OrganizationRole.ADMIN)
    renderOpened(run())
    fireEvent.click(screen.getByRole('button', { name: 'Delete run' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deleteRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('opened-run-run-1')).toBeInTheDocument()
  })

  it('is disabled while the run is still going', () => {
    signIn('user-admin', OrganizationRole.ADMIN)
    renderOpened(run({ status: 'waiting_approval' }))
    expect(screen.getByRole('button', { name: 'Delete run' })).toBeDisabled()
  })

  it('is offered to the member who owns the agent', () => {
    signIn('user-owner', OrganizationRole.MEMBER)
    renderOpened(run())
    expect(screen.getByRole('button', { name: 'Delete run' })).toBeEnabled()
  })

  it('is not offered to a member who does not own the agent, or a viewer', () => {
    signIn('user-member', OrganizationRole.MEMBER)
    renderOpened(run())
    expect(screen.getByTestId('opened-run-run-1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete run' })).not.toBeInTheDocument()
  })

  it('says why when the server refuses, and stays on the run', async () => {
    signIn('user-admin', OrganizationRole.ADMIN)
    deleteRun.mockRejectedValue({ response: { data: { message: 'This run is still going.' } } })
    renderOpened(run())
    fireEvent.click(screen.getByRole('button', { name: 'Delete run' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete run' }))
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not delete the run', expect.any(String)))
    expect(screen.getByTestId('opened-run-run-1')).toBeInTheDocument()
  })
})
