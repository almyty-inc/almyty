import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { ModelAvailabilityBanner } from '../model-availability-banner'
import { modelsApi } from '@/lib/models-api'

vi.mock('@/lib/models-api', () => ({ modelsApi: { agentIssues: vi.fn() } }))

describe('ModelAvailabilityBanner', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows nothing while every model the agent names can be used', async () => {
    vi.mocked(modelsApi.agentIssues).mockResolvedValue([])
    renderWithProviders(<ModelAvailabilityBanner agentId="a1" />)
    await vi.waitFor(() => expect(modelsApi.agentIssues).toHaveBeenCalledWith('a1'))
    expect(screen.queryByTestId('model-availability-banner')).not.toBeInTheDocument()
  })

  it('names the model and the connection, says why, where it is used, and offers to pick another', async () => {
    vi.mocked(modelsApi.agentIssues).mockResolvedValue([
      { model: 'Qwen/Qwen3-32B', modelName: 'Qwen/Qwen3-32B', providerId: 'p1', connectionName: 'HF - everything', reason: 'The provider no longer lists it.', where: ['model', 'role Checker'], since: null },
      { model: 'gpt-4o', modelName: 'gpt-4o', providerId: 'p2', connectionName: null, reason: 'It is turned off on the connection.', where: ['step Summarise'], since: null },
    ])
    renderWithProviders(<ModelAvailabilityBanner agentId="a1" />)
    const banner = await screen.findByTestId('model-availability-banner')
    expect(banner).toHaveTextContent('Qwen/Qwen3-32B is no longer available from HF - everything.')
    expect(banner).toHaveTextContent('The provider no longer lists it. Used in: model, role Checker.')
    expect(within(banner).getByRole('link', { name: 'HF - everything' })).toHaveAttribute('href', '/credentials/providers/p1')
    // A connection the viewer may not see is not named.
    expect(banner).toHaveTextContent('gpt-4o is no longer available from its connection.')
    expect(within(banner).getByRole('link', { name: 'Pick another model' })).toHaveAttribute('href', '/agents/a1/edit')
  })
})
