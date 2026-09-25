/**
 * The builder's copy of the models rules: what blocks Save, in what words,
 * and what the page sends. The backend refuses the same things with a 400;
 * here they are caught before the request.
 */
import { describe, it, expect } from 'vitest'

import type { AgentModelRole, AgentModels } from '@/types/agent-models'
import {
  missingSlotsSentence,
  modelsFromAgent,
  modelsPayload,
  modelsProblems,
  newAgentModels,
  newRole,
  nextRoleKey,
  roleIsUsed,
} from '../agent-models'

const main: AgentModelRole = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p1', model: 'big' }
const routed = (key: string, purpose: AgentModelRole['purpose'], name = key): AgentModelRole => ({
  key,
  name,
  purpose,
  kind: 'model',
  routing: { objective: 'cheapest' },
})

describe('missing slots', () => {
  it('names every slot a strategy is missing in one sentence', () => {
    expect(missingSlotsSentence({ strategy: 'cascade', roles: [main] })).toBe('Cascade needs a drafter and a checker')
    expect(missingSlotsSentence({ strategy: 'explore_extract_patch', roles: [main] })).toBe(
      'Explore, extract, patch needs an explorer, a summariser and a checker',
    )
    expect(missingSlotsSentence({ strategy: 'panel', roles: [main] })).toBe('Panel needs 2 panelists')
    expect(missingSlotsSentence({ strategy: 'panel', roles: [main, routed('panelist_1', 'panelist')] })).toBe(
      'Panel needs 1 more panelist',
    )
    expect(missingSlotsSentence({ strategy: 'single', roles: [main] })).toBeNull()
  })

  it('blocks the save until the slots are filled', () => {
    const models: AgentModels = { strategy: 'best_of_n', roles: [main] }
    expect(modelsProblems(models)).toEqual(['Best of N needs a checker'])
    expect(modelsProblems({ ...models, roles: [main, routed('checker', 'checker')] })).toEqual([])
  })
})

describe('the rules the backend enforces', () => {
  it('asks for a model on a model role, in words that fix it', () => {
    expect(modelsProblems(newAgentModels())).toEqual(['Main: pick a model, or route it by policy'])
  })

  it('lets only panelists and teammates be another agent', () => {
    const models: AgentModels = {
      strategy: 'single',
      roles: [
        main,
        { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'agent', agentId: 'a2' },
        { key: 'teammate_1', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: 'a2' },
      ],
    }
    expect(modelsProblems(models)).toEqual([
      'Checker is another agent, and a checker has to be a model: only panelists and teammates can be agents',
    ])
  })

  it('asks which agent an agent role is', () => {
    const models: AgentModels = {
      strategy: 'single',
      roles: [main, { key: 'teammate_1', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: '' }],
    }
    expect(modelsProblems(models)).toEqual(['Helper: choose the agent'])
  })

  it('allows one of each one-of purpose and needs a main', () => {
    expect(modelsProblems({ strategy: 'single', roles: [main, routed('checker', 'checker'), routed('checker_2', 'checker')] })).toContain(
      'There are 2 checker roles; there can be one',
    )
    expect(modelsProblems({ strategy: 'single', roles: [routed('checker', 'checker')] })).toEqual([
      'Choose a main role: it runs the loop',
    ])
  })

  it('bounds temperature, max tokens and N', () => {
    const problems = modelsProblems({
      strategy: 'best_of_n',
      candidates: 9,
      roles: [{ ...main, temperature: 3, maxTokens: 1.5 }, routed('checker', 'checker')],
    })
    expect(problems).toEqual([
      'Main: temperature must be a number from 0 to 2',
      'Main: max tokens must be a positive whole number',
      'Best of N takes 2 to 5 candidates',
    ])
  })
})

describe('roles', () => {
  it('keys a new role by its purpose, numbering the ones there can be several of', () => {
    expect(nextRoleKey([main], 'drafter')).toBe('drafter')
    expect(nextRoleKey([main], 'panelist')).toBe('panelist_1')
    expect(nextRoleKey([main, routed('panelist_1', 'panelist')], 'panelist')).toBe('panelist_2')
    expect(newRole([main, routed('panelist_1', 'panelist', 'Panelist 1')], 'panelist')).toEqual({
      key: 'panelist_2',
      name: 'Panelist 2',
      purpose: 'panelist',
      kind: 'model',
    })
  })

  it('says a role is unused only when the strategy does not read its purpose; teammates always are', () => {
    expect(roleIsUsed('single', { purpose: 'drafter' })).toBe(false)
    expect(roleIsUsed('cascade', { purpose: 'drafter' })).toBe(true)
    expect(roleIsUsed('panel', { purpose: 'checker' })).toBe(true)
    expect(roleIsUsed('single', { purpose: 'teammate' })).toBe(true)
  })
})

describe('loading and saving', () => {
  it('reads an agent without models as Single on its modelConfig', () => {
    expect(modelsFromAgent({ models: null, modelConfig: { providerId: 'p1', model: 'm', temperature: 0.2, compaction: {} } })).toEqual({
      strategy: 'single',
      roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p1', model: 'm', temperature: 0.2 }],
    })
    expect(modelsFromAgent({})).toEqual(newAgentModels())
  })

  it('sends only the fields that apply to each role, and N only for Best of N', () => {
    const payload = modelsPayload({
      strategy: 'cascade',
      candidates: 4,
      roles: [
        { ...main, agentId: 'stale', instructions: '  ' },
        { key: 'drafter', name: ' Drafter ', purpose: 'drafter', kind: 'model', providerId: 'p1', routing: { objective: 'cheapest' } },
        { key: 'teammate_1', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: 'a2', providerId: 'p1', temperature: 1 },
      ],
    })
    expect(payload).toEqual({
      strategy: 'cascade',
      roles: [
        { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p1', model: 'big' },
        { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', routing: { objective: 'cheapest' } },
        { key: 'teammate_1', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: 'a2' },
      ],
    })
    expect(modelsPayload({ strategy: 'best_of_n', roles: [main] }).candidates).toBe(3)
  })
})
