import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { VerifyConfigDialog } from '../verify-config-dialog'
import { agentsApi, llmProvidersApi } from '@/lib/api'
import type { Agent } from '@/types'

vi.mock('@/lib/api', () => ({
  agentsApi: { update: vi.fn().mockResolvedValue({}) },
  llmProvidersApi: { getAll: vi.fn() },
}))

const agent = (): Agent =>
  ({
    id: 'a1',
    name: 'Customer Support Orchestrator',
    mode: 'autonomous',
    agentConfig: {
      canCallAgents: true,
      constraints: { enabled: true },
      verify: {
        enabled: true,
        policy: 'majority',
        maxReviseLoops: 2,
        triggers: ['on_final_output'],
        checkers: [{ name: 'Claude reviewer', providerId: 'p-anthropic', model: 'claude' }],
      },
    },
  } as Agent)

describe('VerifyConfigDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(llmProvidersApi.getAll as any).mockResolvedValue({
      providers: [{ id: 'p-anthropic', name: 'Anthropic', type: 'anthropic' }],
    })
  })

  it('opens with the existing verify config and preserves other agentConfig on save', async () => {
    renderWithProviders(<VerifyConfigDialog agent={agent()} />)

    fireEvent.click(screen.getByRole('button', { name: /Configure/ }))

    // Dialog opened with the existing reviewer pre-filled
    expect(await screen.findByText('Verification')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Claude reviewer')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1))
    const [id, payload] = (agentsApi.update as any).mock.calls[0]
    expect(id).toBe('a1')
    // Preserves canCallAgents + constraints, writes verify.checkers
    expect(payload.agentConfig.canCallAgents).toBe(true)
    expect(payload.agentConfig.constraints).toEqual({ enabled: true })
    expect(payload.agentConfig.verify.policy).toBe('majority')
    expect(payload.agentConfig.verify.checkers).toHaveLength(1)
    expect(payload.agentConfig.verify.checkers[0].providerId).toBe('p-anthropic')
  })
})
