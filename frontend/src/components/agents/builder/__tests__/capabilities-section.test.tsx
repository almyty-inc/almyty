import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/setup'
import { CapabilitiesSection } from '../capabilities-section'
vi.mock('@/store/organization', () => ({ useOrganizationStore: (select: any) => select({ currentOrganization: { id: 'o1' } }) }))
vi.mock('@/lib/api', () => ({
  apisApi: { getAll: vi.fn().mockResolvedValue([]) },
  runnersApi: { getAll: vi.fn().mockResolvedValue([{ id: 'r1', name: 'Studio', state: 'online', labels: {} }, { id: 'r2', name: 'Build box', state: 'offline', labels: {} }]) },
}))

describe('agent runner choice', () => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  it('picks a specific machine by name/status and keeps labels under Advanced', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    renderWithProviders(<CapabilitiesSection toolIds={[]} onToolIdsChange={vi.fn()} tools={[]} agentConfig={{}} onAgentConfigChange={change} availableAgents={[]} />)
    const select = screen.getByRole('combobox', { name: 'Runs on' })
    expect(select).toHaveTextContent('Any of my runners')
    expect(screen.getByText('Advanced').closest('details')).not.toHaveAttribute('open')
    await user.click(select)
    await user.click(await screen.findByRole('option', { name: 'Studio (online)' }))
    expect(change).toHaveBeenLastCalledWith({ runnerId: 'r1' })
  })
  it('preserves an unavailable saved runner rather than silently using any machine', () => {
    renderWithProviders(<CapabilitiesSection toolIds={[]} onToolIdsChange={vi.fn()} tools={[]} agentConfig={{ runnerId: 'deleted-runner' }} onAgentConfigChange={vi.fn()} availableAgents={[]} />)
    expect(screen.getByRole('combobox', { name: 'Runs on' })).toHaveTextContent('Selected runner (unavailable)')
    expect(screen.getByText(/another machine is never substituted/)).toBeInTheDocument()
  })
})
