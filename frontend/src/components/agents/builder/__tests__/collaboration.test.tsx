/**
 * Collaboration participants are agents or models.
 *
 * The card used to list other agents and nothing else, so an organization
 * with one agent met "No other agents available." and could go no further,
 * though the point is to run several models in sequence, in parallel, as a
 * race or a debate. These pin that a model is a first-class participant,
 * that models alone are enough, and what the builder saves.
 */
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { AutonomousConfig } from '../autonomous-config'
import {
  EMPTY_COLLABORATION,
  collaborationFromAgent,
  collaborationPayload,
  collaborationProblems,
  type CollaborationState,
} from '../collaboration'
import { llmProvidersApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: {
    getAll: vi.fn(),
  },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))

const OPENAI = { id: 'prov-openai', name: 'OpenAI', type: 'openai', status: 'active' }

/** AutonomousConfig with its collaboration state held here, as the builder holds it. */
function Harness({ initial, agents = [], onState }: { initial: CollaborationState; agents?: any[]; onState: (s: CollaborationState) => void }) {
  const [collab, setCollab] = useState(initial)
  return (
    <AutonomousConfig
      agentId="self"
      personality=""
      onPersonalityChange={() => {}}
      instructions=""
      onInstructionsChange={() => {}}
      modelConfig={{}}
      onModelConfigChange={() => {}}
      toolIds={[]}
      onToolIdsChange={() => {}}
      tools={[]}
      memoryConfig={{}}
      onMemoryConfigChange={() => {}}
      agentConfig={{}}
      onAgentConfigChange={() => {}}
      collaboration={collab}
      onCollaborationChange={(next) => {
        setCollab(next)
        onState(next)
      }}
      availableAgents={agents}
      heartbeat={{ enabled: false, intervalMinutes: 60, prompt: '' }}
      onHeartbeatChange={() => {}}
    />
  )
}

describe('collaboration card', () => {
  beforeEach(() => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([OPENAI] as any)
  })

  it('works with models alone when there are no other agents', async () => {
    const onState = vi.fn()
    renderWithProviders(<Harness initial={{ ...EMPTY_COLLABORATION, enabled: true }} onState={onState} />)

    // Not the old dead end.
    expect(screen.queryByText('No other agents available.')).not.toBeInTheDocument()
    expect(screen.getByTestId('no-other-agents')).toHaveTextContent('models work without one')
    expect(screen.getByRole('button', { name: /Add agent/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Add model/ }))
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }))
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ participants: [{ kind: 'model' }, { kind: 'model' }] }))

    // Each model participant chooses its model with the shared picker,
    // Automatic included.
    const first = screen.getByTestId('participant-0')
    const picker = await within(first).findByRole('combobox', { name: 'Model' })
    await vi.waitFor(() => expect(picker).not.toBeDisabled())
    expect(picker).toHaveTextContent('Choose a model')
    fireEvent.click(picker)
    expect(within(first).getByRole('option', { name: /Automatic/ })).toBeInTheDocument()
  })

  it('mixes agents and models, in order, for a sequential chain', async () => {
    const onState = vi.fn()
    const initial: CollaborationState = {
      ...EMPTY_COLLABORATION,
      enabled: true,
      participants: [
        { kind: 'model', providerId: OPENAI.id, model: 'gpt-4o', role: 'drafter' },
        { kind: 'agent', agentId: 'critic' },
      ],
    }
    renderWithProviders(<Harness initial={initial} agents={[{ id: 'self', name: 'Me' }, { id: 'critic', name: 'Critic' }]} onState={onState} />)

    expect(screen.getByTestId('participant-0')).toHaveTextContent('1. Model')
    expect(screen.getByTestId('participant-1')).toHaveTextContent('2. Agent')

    fireEvent.click(screen.getByRole('button', { name: 'Move participant 2 up' }))
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({
      participants: [{ kind: 'agent', agentId: 'critic' }, { kind: 'model', providerId: OPENAI.id, model: 'gpt-4o', role: 'drafter' }],
    }))
  })

  it('lets a model judge when there is no other agent to judge', async () => {
    const onState = vi.fn()
    renderWithProviders(
      <Harness
        initial={{ ...EMPTY_COLLABORATION, enabled: true, strategy: 'parallel', participants: [{ kind: 'model', providerId: OPENAI.id }], judge: { kind: 'model' } }}
        onState={onState}
      />,
    )
    // Radix renders the chosen item's text in the trigger.
    expect(screen.getByText('A model')).toBeInTheDocument()
    // The judge picks its model with the same picker as everyone else.
    expect(await screen.findByTestId('autonomous-judge-model-trigger')).toBeInTheDocument()
    expect(screen.queryByTestId('no-judge-agents')).not.toBeInTheDocument()
  })
})

describe('collaboration state', () => {
  it('refuses to save collaboration switched on with nobody in it', () => {
    expect(collaborationProblems({ ...EMPTY_COLLABORATION, enabled: true })).toEqual([
      'Add a model or an agent to the collaboration, or switch it off',
    ])
    expect(collaborationProblems(EMPTY_COLLABORATION)).toEqual([])
  })

  it('refuses a model participant or judge with neither a provider nor a policy', () => {
    const problems = collaborationProblems({
      ...EMPTY_COLLABORATION,
      enabled: true,
      participants: [{ kind: 'model' }, { kind: 'model', routing: { objective: 'cheapest' } }],
      judge: { kind: 'model' },
    })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/provider for collaboration participant 1/)
    expect(problems[1]).toMatch(/provider for the judge/)
  })

  it('saves participants and judge in the shape the engine reads', () => {
    const payload = collaborationPayload({
      enabled: true,
      strategy: 'parallel',
      participants: [{ kind: 'model', providerId: 'p', model: 'm' }, { kind: 'agent', agentId: 'a' }],
      judge: { kind: 'model', providerId: 'p' },
      rules: { maxTotalCost: 1 },
      maxRounds: 5,
    })
    expect(payload).toEqual({
      strategy: 'parallel',
      participants: [{ kind: 'model', providerId: 'p', model: 'm' }, { kind: 'agent', agentId: 'a' }],
      sharedBrief: undefined,
      rules: { maxTotalCost: 1 },
      judge: { kind: 'model', providerId: 'p' },
      // Rounds only mean something to a debate.
      maxRounds: undefined,
    })
    expect(collaborationPayload(EMPTY_COLLABORATION)).toBeNull()
  })

  it('drops a judge the strategy never consults', () => {
    const payload = collaborationPayload({
      enabled: true,
      strategy: 'sequential',
      participants: [{ kind: 'model', providerId: 'p' }],
      judge: { kind: 'model', providerId: 'p' },
    })
    expect(payload?.judge).toBeUndefined()
  })

  it('reads a saved collaboration back into the builder', () => {
    const state = collaborationFromAgent({ strategy: 'debate', participants: [{ kind: 'model', providerId: 'p' }], maxRounds: 2 })
    expect(state).toMatchObject({ enabled: true, strategy: 'debate', participants: [{ kind: 'model', providerId: 'p' }], maxRounds: 2 })
    expect(collaborationFromAgent(null)).toBe(EMPTY_COLLABORATION)
  })
})
