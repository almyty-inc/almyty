import { expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test/setup'
import { GatewayAccessSection } from '../gateway-access-section'
import { gatewaysApi } from '@/lib/api'
vi.mock('@/hooks/use-organization-role', () => ({ useOrganizationRole: () => ({ canManage: true }) }))
vi.mock('@/lib/api', () => ({ organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) }, gatewaysApi: { update: vi.fn().mockResolvedValue({}) } }))
it('saves open access explicitly and turns off scripts while preserving other configuration', async () => {
  const user = userEvent.setup()
  render(<GatewayAccessSection gateway={{ id: 'gw-1', name: 'Partner', accessScope: 'org', configuration: { exposure: 'both', transport: 'http' } }} />)
  expect(screen.queryByTestId('gateway-sign-in-methods')).not.toBeInTheDocument()
  await user.click(screen.getByRole('radio', { name: /Outside, open/ }))
  expect(gatewaysApi.update).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Save access' }))
  await waitFor(() => expect(gatewaysApi.update).toHaveBeenCalledWith('gw-1', { accessScope: 'external_open', accessTeamId: null, configuration: { exposure: 'tools', transport: 'http' } }))
})
