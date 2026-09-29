import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { AgentConfigPanel } from '../agent-config-panel'
import { agentsApi, llmProvidersApi } from '@/lib/api'
import type { Agent } from '@/types'

vi.mock('@/lib/api', () => ({
  agentsApi: { update: vi.fn().mockResolvedValue({}) },
  llmProvidersApi: { getAll: vi.fn() },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))

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

describe('verification settings, edited on the agent page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(llmProvidersApi.getAll as any).mockResolvedValue({
      providers: [{ id: 'p-anthropic', name: 'Anthropic', type: 'anthropic' }],
    })
  })

  it('opens in place, not in a dialog, with the saved config, and preserves other agentConfig on save', async () => {
    renderWithProviders(<AgentConfigPanel agent={agent()} />)

    fireEvent.click(screen.getByRole('button', { name: /Configure verification/ }))

    // Inline on the page: the editor is there and no dialog was opened.
    expect(await screen.findByTestId('verify-config-editor')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('Claude reviewer')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Save verification$/ }))

    await waitFor(() => expect(agentsApi.update).toHaveBeenCalledTimes(1))
    const [id, payload] = (agentsApi.update as any).mock.calls[0]
    expect(id).toBe('a1')
    // Preserves canCallAgents + constraints, writes verify.checkers
    expect(payload.agentConfig.canCallAgents).toBe(true)
    expect(payload.agentConfig.constraints).toEqual({ enabled: true })
    expect(payload.agentConfig.verify.policy).toBe('majority')
    expect(payload.agentConfig.verify.checkers).toHaveLength(1)
    expect(payload.agentConfig.verify.checkers[0].providerId).toBe('p-anthropic')
    expect(payload.agentConfig.verify.checkers[0].model).toBe('claude')
    // Saving closes the editor again.
    await waitFor(() => expect(screen.queryByTestId('verify-config-editor')).not.toBeInTheDocument())
  })

  it('picks each reviewer model from the shared picker, not a free-text box', async () => {
    renderWithProviders(<AgentConfigPanel agent={agent()} />)
    fireEvent.click(screen.getByRole('button', { name: /Configure verification/ }))
    await screen.findByTestId('verify-config-editor')
    // The provider lists no models: the saved one stays on the field
    // rather than reading as unset, and nothing asks for free text.
    await waitFor(() => expect(screen.getByTestId('verify-reviewer-0-model-value')).toHaveTextContent('claude'))
    expect(screen.queryByTestId('verify-reviewer-0-model-input')).not.toBeInTheDocument()
  })
})