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
    // Real endpoint returns a { providers: [...] } envelope, not a bare array.
    ;(llmProvidersApi.getAll as any).mockResolvedValue({ providers })
  })

  it('surfaces the multi-vendor verifier panel with resolved provider names', async () => {
    renderWithProviders(<AgentConfigPanel agent={agent()} />)

    // Headline: two vendors across the roles and the reviewers, in plain words
    expect(await screen.findByText('Uses models from 2 providers.')).toBeInTheDocument()
    // The main role + GPT-4o reviewer both render the model id
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
    const models = await screen.findByTestId('overview-models')
    expect(models).toHaveTextContent('Single')
    expect(models).toHaveTextContent('gpt-4o')
    expect(screen.queryByText('Verifier panel')).not.toBeInTheDocument()
  })

  it('shows the roles and strategy the edit page shows, collaborators included, not a lone primary model', async () => {
    renderWithProviders(
      <AgentConfigPanel
        agent={agent({
          models: {
            strategy: 'cascade',
            roles: [
              { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-openai', model: 'gpt-4o' },
              { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', routing: { objective: 'cheapest' } },
              { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'p-anthropic', model: 'claude-haiku' },
            ],
          },
          collaboration: { participants: [{ kind: 'agent', agentId: 'critic', role: 'Critic' }] },
        })}
      />,
    )
    const models = await screen.findByTestId('overview-models')
    expect(models).toHaveTextContent('Cascade')
    for (const text of ['Main', 'Drafter', 'Automatic', 'Checker', 'claude-haiku', 'Critic', 'Another agent']) expect(models).toHaveTextContent(text)
    expect(screen.queryByText('Primary model')).not.toBeInTheDocument()
  })
})
