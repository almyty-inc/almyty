import { beforeEach, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test/setup'
import { AgentApiAccessSection } from '../agent-api-access-section'
import { agentsApi } from '@/lib/api'
vi.mock('@/hooks/use-organization-role', () => ({ useCanManageAgent: () => true }))
vi.mock('@/lib/api', () => ({
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  agentsApi: { getApiAccess: vi.fn(), setApiAccess: vi.fn() },
  gatewaysApi: { getAuthConfigs: vi.fn().mockResolvedValue([]), listApiKeys: vi.fn().mockResolvedValue([]) },
}))
beforeEach(() => vi.clearAllMocks())
it('bootstraps the agent auth target only when protected access is explicitly saved', async () => {
  const user = userEvent.setup()
  vi.mocked(agentsApi.getApiAccess).mockResolvedValue(null)
  vi.mocked(agentsApi.setApiAccess).mockResolvedValue({ gatewayId: 'api-gw', accessScope: 'external_protected', accessTeamId: null })
  render(<AgentApiAccessSection agentId="agent-1" />)
  const protectedChoice = await screen.findByRole('radio', { name: /Outside, protected/ })
  await waitFor(() => expect(protectedChoice).toBeEnabled())
  await user.click(protectedChoice)
  expect(agentsApi.setApiAccess).not.toHaveBeenCalled()
  expect(screen.queryByTestId('gateway-sign-in-methods')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Save API access' }))
  await waitFor(() => expect(agentsApi.setApiAccess).toHaveBeenCalledWith('agent-1', { accessScope: 'external_protected', accessTeamId: null }))
  expect(await screen.findByRole('checkbox', { name: 'Company sign-in' })).toBeInTheDocument()
})
it('shows an error without exposing edit controls when access cannot be read', async () => {
  vi.mocked(agentsApi.getApiAccess).mockRejectedValue(new Error('denied'))
  render(<AgentApiAccessSection agentId="agent-1" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('API access could not be loaded.')
  expect(screen.queryByRole('radio')).not.toBeInTheDocument()
})
