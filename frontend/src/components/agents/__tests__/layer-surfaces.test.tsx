import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '../../../test/setup'
import { RolesPanel } from '../roles-panel'
import { StrategyPicker } from '../strategy-picker'
import { OrchestratorSettings } from '../orchestrator-settings'

/**
 * The surfaces for L4, L5 and L6.
 *
 * What each is asserted to make visible is the thing its layer exists for:
 * that a pinned role does not route, that a strategy never names a model,
 * and that the orchestrator being off leaves the product whole.
 */
describe('the roles panel shows what fills each slot', () => {
  const roles = [
    { key: 'principal', displayName: 'Principal', binding: { mode: 'pinned' as const, modelId: 'card-opus' } },
    { key: 'verifier', displayName: 'Verifier', binding: { mode: 'resolved' as const, policy: { objective: 'cheapest' } } },
  ]

  it('names the model rather than a uuid when it can', () => {
    render(<RolesPanel roles={roles} modelNames={{ 'card-opus': 'Claude Opus' }} />)
    expect(screen.getByTestId('role-model-principal')).toHaveTextContent('Claude Opus')
  })

  it('says a pinned role does not route, which is the point of pinning', () => {
    render(<RolesPanel roles={roles} />)
    expect(screen.getByTestId('role-principal')).toHaveTextContent('chosen directly, no routing')
  })

  it('shows a resolved role as unresolved until something fills it', () => {
    render(<RolesPanel roles={roles} />)
    expect(screen.getByTestId('role-unresolved-verifier')).toBeInTheDocument()
  })

  it('shows the router rationale once the role is filled', () => {
    render(
      <RolesPanel
        roles={roles}
        resolved={[{ key: 'verifier', modelId: 'card-haiku', via: 'resolved', rationale: 'cheapest, rank 1' }]}
        modelNames={{ 'card-haiku': 'Haiku' }}
      />,
    )
    expect(screen.getByTestId('role-verifier')).toHaveTextContent('cheapest, rank 1')
    expect(screen.getByTestId('role-model-verifier')).toHaveTextContent('Haiku')
  })

  it('offers the binding switch in both directions', () => {
    const onToggle = vi.fn()
    render(<RolesPanel roles={roles} onToggleBinding={onToggle} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Let routing choose' })[0])
    expect(onToggle).toHaveBeenCalledWith('principal', 'resolved')

    fireEvent.click(screen.getAllByRole('button', { name: 'Pin a model' })[0])
    expect(onToggle).toHaveBeenCalledWith('verifier', 'pinned')
  })

  it('has a real empty state that says what a role is for', () => {
    render(<RolesPanel roles={[]} onAddRole={() => {}} />)
    expect(screen.getByText('No roles yet')).toBeInTheDocument()
    expect(screen.getByText(/without editing the graph/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a role' })).toBeInTheDocument()
  })

  it('has loading and error states rather than a blank panel', () => {
    const { rerender } = render(<RolesPanel roles={[]} loading />)
    expect(screen.getByTestId('roles-loading')).toBeInTheDocument()
    rerender(<RolesPanel roles={[]} error="Could not read roles: the agent was not found" />)
    expect(screen.getByTestId('roles-error')).toHaveTextContent('the agent was not found')
  })
})

describe('the strategy picker shows shapes, never models', () => {
  const strategies = [
    { key: 'single', displayName: 'Single call', description: 'One call on one role.', roleSlots: ['principal'], steps: 1, costBand: 'low' as const, latencyBand: 'low' as const, builtIn: true },
    { key: 'explore_extract_patch', displayName: 'Explore, extract, patch', description: 'Explore, compress, then act on the brief.', roleSlots: ['explorer', 'summariser', 'principal', 'verifier'], steps: 5, costBand: 'high' as const, latencyBand: 'high' as const, builtIn: true },
  ]

  it('shows slots and bands and no model anywhere', () => {
    render(<StrategyPicker strategies={strategies} availableRoles={['principal']} />)
    const card = screen.getByTestId('strategy-explore_extract_patch')
    expect(card).toHaveTextContent('summariser')
    expect(card).toHaveTextContent('cost high')
    expect(card).toHaveTextContent('5 steps')
    // The invariant, visible on the surface: nothing here is a model.
    expect(card.textContent).not.toMatch(/gpt|claude|gemini|llama/i)
  })

  it('warns before the run about slots this agent cannot fill', () => {
    render(<StrategyPicker strategies={strategies} availableRoles={['principal']} />)
    const warning = screen.getByTestId('strategy-unfillable-explore_extract_patch')
    expect(warning).toHaveTextContent('explorer')
    expect(warning).toHaveTextContent('summariser')
    expect(screen.queryByTestId('strategy-unfillable-single')).not.toBeInTheDocument()
  })

  it('selects one and offers eject only for the selected shape', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<StrategyPicker strategies={strategies} onSelect={onSelect} onEject={() => {}} />)
    expect(screen.queryByTestId('eject-strategy')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('strategy-single'))
    expect(onSelect).toHaveBeenCalledWith('single')

    rerender(<StrategyPicker strategies={strategies} selectedKey="single" onSelect={onSelect} onEject={() => {}} />)
    expect(screen.getByTestId('strategy-single')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('eject-strategy')).toBeInTheDocument()
  })

  it('has an empty state that says an empty list is itself a problem', () => {
    render(<StrategyPicker strategies={[]} />)
    expect(screen.getByText(/built-in shapes should always be here/)).toBeInTheDocument()
  })
})

describe('the orchestrator settings lead with the switch', () => {
  const config = { enabled: false, roleKey: 'orchestrator', timeoutMs: 2000, fallbackStrategyKey: 'single' }

  it('says what happens when it is off, which is the default', () => {
    render(<OrchestratorSettings config={config} strategyKeys={['single']} roleKeys={['orchestrator']} onChange={() => {}} />)
    expect(screen.getByText(/Off by default/)).toBeInTheDocument()
    expect(screen.getByText(/nothing else changes/)).toBeInTheDocument()
    // Nothing to configure until it is on.
    expect(screen.queryByTestId('orchestrator-detail')).not.toBeInTheDocument()
  })

  it('reveals the settings once enabled, and names every fallback path', () => {
    render(
      <OrchestratorSettings
        config={{ ...config, enabled: true }}
        strategyKeys={['single', 'cascade']}
        roleKeys={['orchestrator', 'cheap']}
        onChange={() => {}}
      />,
    )
    const detail = screen.getByTestId('orchestrator-detail')
    expect(detail).toHaveTextContent('times out')
    expect(detail).toHaveTextContent('answers something unusable')
    expect(detail).toHaveTextContent('never left without a strategy')
    expect(detail).toHaveTextContent('counted against the budget')
  })

  it('reports a change without mutating what it was given', () => {
    const onChange = vi.fn()
    const original = { ...config }
    render(<OrchestratorSettings config={config} strategyKeys={['single']} roleKeys={['orchestrator']} onChange={onChange} />)

    fireEvent.click(screen.getByRole('switch'))

    expect(onChange).toHaveBeenCalledWith({ ...config, enabled: true })
    expect(config).toEqual(original)
  })
})
