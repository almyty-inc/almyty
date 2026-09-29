/**
 * A run of a multi-model agent says which role acted on each step, on
 * which model, and what each role cost.
 *
 * Without this, a cascade run read as a list of llm_call steps with no way
 * to tell the cheap drafter from the main model, or to see where the money
 * went. Runs from before roles existed carry none of it and must still
 * render as they did.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { RunsTab } from '../runs-tab'
import type { AgentRun } from '@/types'

vi.mock('@/lib/api', () => ({ promotedSkillsApi: { promote: vi.fn() } }))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))

const role = (key: string, name: string, purpose: string, kind: 'model' | 'agent' = 'model') => ({ key, name, purpose, kind })

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    organizationId: 'org-1',
    mode: 'autonomous',
    status: 'running',
    thread: [],
    workingMemory: {},
    steps: [],
    currentStep: 4,
    maxSteps: 20,
    totalCost: 0.0231,
    totalTokens: 5400,
    executionTime: 4200,
    createdAt: '2026-09-24T10:00:00Z',
    updatedAt: '2026-09-24T10:00:05Z',
    ...overrides,
  }
}

const CASCADE_RUN = run({
  metadata: {
    strategy: 'cascade',
    roleCosts: {
      drafter: { name: 'Drafter', purpose: 'drafter', cost: 0.0012, tokens: 3000, calls: 2 },
      main: { name: 'Main', purpose: 'main', cost: 0.0204, tokens: { input: 1500, output: 400 }, calls: 1 },
      checker: { name: 'Checker', purpose: 'checker', cost: 0.0015, tokens: 500, calls: 1 },
    },
  },
  steps: [
    {
      type: 'llm_call',
      timestamp: '2026-09-24T10:00:01Z',
      role: role('drafter', 'Drafter', 'drafter'),
      cost: 0.0012,
      tokens: { input: 2500, output: 500 },
      duration: 900,
      output: { status: 'drafted', model: 'gpt-4o-mini', providerId: 'prov-openai' },
    },
    {
      type: 'verify',
      timestamp: '2026-09-24T10:00:02Z',
      role: role('checker', 'Checker', 'checker'),
      cost: 0.0015,
      output: { verdict: 'fail', failures: [{ rule: 'unsupported claim' }], model: 'claude-haiku' },
    },
    {
      type: 'llm_call',
      timestamp: '2026-09-24T10:00:03Z',
      role: role('main', 'Main', 'main'),
      cost: 0.0204,
      output: {
        status: 'escalated',
        routing: { modelId: 'card-1', modelVersionId: null, vendorModelId: 'gpt-4o', providerId: 'prov-openai', rationale: 'cheapest validated', attempt: 1, tried: [], rejected: [] },
      },
    },
    {
      type: 'judge',
      timestamp: '2026-09-24T10:00:04Z',
      role: role('checker', 'Checker', 'checker'),
      output: { strategy: 'best_of_n', picked: 2, candidates: 3 },
    },
    {
      type: 'teammate_call',
      timestamp: '2026-09-24T10:00:05Z',
      role: role('teammate_1', 'Critic', 'teammate', 'agent'),
      input: { teammate: 'teammate_1' },
      output: { preview: 'Two sources disagree on the date.' },
    },
  ],
})

function openRun(r: AgentRun) {
  renderWithProviders(<RunsTab runs={[r]} />)
  fireEvent.click(screen.getByRole('button', { expanded: false }))
}

describe('an autonomous run with several models', () => {
  it('shows which role and model acted on each step, and its cost', () => {
    openRun(CASCADE_RUN)

    const drafted = screen.getByTestId('run-step-0')
    expect(within(drafted).getByTestId('step-role')).toHaveTextContent('Drafter')
    expect(drafted).toHaveTextContent('gpt-4o-mini')
    expect(drafted).toHaveTextContent('Drafted an answer for the checker')
    expect(drafted).toHaveTextContent('$0.0012')
    expect(drafted).toHaveTextContent('2,500 in / 500 out')

    const escalated = screen.getByTestId('run-step-2')
    expect(within(escalated).getByTestId('step-role')).toHaveTextContent('Main')
    expect(escalated).toHaveTextContent('The draft failed the check; the main role redoes this step')
    // A routed call names the card that answered.
    expect(within(escalated).getByTestId('routing-attribution')).toHaveTextContent('gpt-4o')
    expect(escalated).toHaveTextContent('$0.0204')

    expect(screen.getByTestId('run-step-3')).toHaveTextContent('Picked candidate 2 of 3')
    const handed = screen.getByTestId('run-step-4')
    expect(handed).toHaveTextContent('Critic')
    expect(handed).toHaveTextContent('Handed work to teammate_1 — Two sources disagree on the date.')
    // Summarised steps do not repeat themselves as raw JSON.
    expect(handed).not.toHaveTextContent('Out:')
  })

  it('stamps the checker on its verify step too', () => {
    openRun(CASCADE_RUN)
    const verify = screen.getAllByTestId('step-role').find((el) => el.textContent?.includes('claude-haiku'))
    expect(verify).toHaveTextContent('Checker')
  })

  it('puts a cost-by-role table at the top of the steps, most expensive first', () => {
    openRun(CASCADE_RUN)
    const table = screen.getByTestId('role-costs')
    expect(table).toHaveTextContent('Cost by role')
    expect(within(table).getByTestId('run-strategy')).toHaveTextContent('Cascade')

    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['role-cost-main', 'role-cost-checker', 'role-cost-drafter'])
    expect(within(table).getByTestId('role-cost-main')).toHaveTextContent(/Main\s*Main\s*1\s*1,900\s*\$0\.0204/)
    expect(within(table).getByTestId('role-cost-drafter')).toHaveTextContent(/Drafter\s*Drafter\s*2\s*3,000\s*\$0\.0012/)

    // Above the steps, not after them.
    const steps = screen.getByRole('heading', { name: 'Steps' })
    expect(table.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders an older run without roles as it always did', () => {
    openRun(
      run({
        steps: [{ type: 'llm_call', timestamp: '2026-09-24T10:00:01Z', cost: 0.002, output: { content: 'hello' } }],
      }),
    )
    expect(screen.queryByTestId('role-costs')).not.toBeInTheDocument()
    expect(screen.queryByTestId('step-role')).not.toBeInTheDocument()
    expect(screen.getByTestId('run-step-0')).toHaveTextContent('Out: {"content":"hello"}')
    expect(screen.getByTestId('run-step-0')).toHaveTextContent('$0.0020')
  })
})
