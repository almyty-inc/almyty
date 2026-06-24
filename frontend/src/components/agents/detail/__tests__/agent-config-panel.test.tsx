import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '../../../../test/setup'
import { AgentConfigPanel } from '../agent-config-panel'
import { llmProvidersApi } from '@/lib/api'
import type { Agent } from '@/types'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn() },
}))

const providers = [
  { id: 'p-openai', name: 'OpenAI · GPT-4o', type: 'openai' },
  { id: 'p-anthropic', name: 'Anthropic · Claude', type: 'anthropic' },
]

const agent = (over: any = {}): Agent =>
  ({
    id: 'a1',
    name: 'Customer Support Orchestrator',
    mode: 'autonomous',
    modelConfig: { providerId: 'p-openai', model: 'gpt-4o', temperature: 0.3 },
    memoryConfig: { enabled: true, autoSave: true },
    agentConfig: {
      verify: {
        enabled: true,
        policy: 'any_fail_blocks',
        maxReviseLoops: 2,
        triggers: ['on_final_output'],
        checkers: [
          { name: 'Claude reviewer', providerId: 'p-anthropic', model: 'claude-opus-4' },
          { name: 'GPT-4o reviewer', providerId: 'p-openai', model: 'gpt-4o' },
        ],
      },
      constraints: { enabled: true, autoLearn: true },
    },
    ...over,
  } as Agent)

describe('AgentConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(llmProvidersApi.getAll as any).mockResolvedValue(providers)
  })

  it('surfaces the multi-vendor verifier panel with resolved provider names', async () => {
    renderWithProviders(<AgentConfigPanel agent={agent()} />)

    // Headline: 2 vendors collaborating in one agent
    expect(await screen.findByText(/2 LLM vendors collaborating/)).toBeInTheDocument()
    // Primary model + GPT-4o reviewer both render the model id
    expect(screen.getAllByText('gpt-4o').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Claude reviewer')).toBeInTheDocument()
    expect(screen.getByText('GPT-4o reviewer')).toBeInTheDocument()
    expect(screen.getByText('any_fail_blocks')).toBeInTheDocument()
    // Feature chips
    expect(screen.getByText(/Constraints/)).toBeInTheDocument()
    expect(screen.getByText(/Memory/)).toBeInTheDocument()
  })

  it('renders the primary model even when verify is off', async () => {
    renderWithProviders(
      <AgentConfigPanel agent={agent({ agentConfig: {}, memoryConfig: {} })} />,
    )
    expect(await screen.findByText('Primary model')).toBeInTheDocument()
    expect(screen.queryByText('Verifier panel')).not.toBeInTheDocument()
  })
})
