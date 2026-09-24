import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { LlmProvidersPage } from '../llm-providers'
import { llmProvidersApi } from '@/lib/api'

// Deleting a provider takes its key and usage history with it, so the row
// menu asks through the shared confirm before the mutation runs.

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn(), delete: vi.fn(), update: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

const PROVIDER = { id: 'p1', name: 'Team OpenAI', type: 'openai', status: 'active' }

async function openDelete() {
  const user = userEvent.setup()
  render(<LlmProvidersPage />)
  await screen.findByText('Team OpenAI')
  await user.click(screen.getByRole('button', { name: /actions/i }))
  await user.click(await screen.findByText('Delete'))
  return { user, dialog: await screen.findByRole('alertdialog') }
}

describe('LlmProvidersPage delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([PROVIDER] as any)
  })

  it('asks before deleting, naming the provider', async () => {
    const { dialog } = await openDelete()
    expect(within(dialog).getByText('Delete this provider?')).toBeInTheDocument()
    expect(within(dialog).getByText(/delete "Team OpenAI"\? This action cannot be undone/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Delete provider' })).toBeInTheDocument()
    expect(llmProvidersApi.delete).not.toHaveBeenCalled()
  })

  it('cancelling leaves the provider alone', async () => {
    const { user, dialog } = await openDelete()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(llmProvidersApi.delete).not.toHaveBeenCalled()
  })

  it('deletes the provider once confirmed', async () => {
    vi.mocked(llmProvidersApi.delete).mockResolvedValue({} as any)
    const { user, dialog } = await openDelete()
    await user.click(within(dialog).getByRole('button', { name: 'Delete provider' }))
    await waitFor(() => expect(llmProvidersApi.delete).toHaveBeenCalledWith('p1'))
  })
})