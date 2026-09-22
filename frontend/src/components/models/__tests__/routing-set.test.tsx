import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '../../../test/setup'
import { RoutingSetBar, buildRoutingPolicy, vendorsOf } from '../routing-set'
import { modelOrigin, modelVendor, whereItRuns } from '../model-origin'
import type { ModelCard } from '@/types/models'

const copy = vi.fn()
vi.mock('../../../lib/clipboard', () => ({ useCopy: () => copy }))

function card(overrides: Partial<ModelCard> = {}): ModelCard {
  return {
    id: 'c1',
    organizationId: 'org',
    name: 'Sonnet',
    providerId: 'p1',
    providerType: 'anthropic',
    vendorModelId: 'claude-sonnet-5',
    endpointRef: null,
    base: null,
    modelVersionId: null,
    capabilities: { tools: true },
    contextLength: 200000,
    pricing: null,
    pricingSource: 'feed:litellm',
    pricingFetchedAt: null,
    pricingOverride: null,
    measuredLatencyMs: null,
    privacyTier: 'public',
    region: null,
    status: 'active',
    validationStatus: 'passed',
    lastValidatedAt: null,
    lastValidationError: null,
    metadata: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    selectable: true,
    effectivePricing: null,
    ...overrides,
  }
}

const providerNames = { p1: 'Anthropic prod', p2: 'Moonshot' }

describe('model origin', () => {
  it('tells the three ways a card reaches the catalog apart', () => {
    expect(modelOrigin(card())).toBe('vendor')
    expect(modelOrigin(card({ endpointRef: { url: 'http://10.0.0.5:8000/v1' } }))).toBe('endpoint')
    expect(modelOrigin(card({ endpointRef: { url: 'https://x.hf.space/v1', deploymentId: 'd-1' } }))).toBe('deployment')
  })

  it('names the vendor and where the call goes', () => {
    expect(modelVendor(card(), providerNames)).toBe('Anthropic prod')
    expect(modelVendor(card({ providerId: null, providerType: null, endpointRef: { url: 'http://10.0.0.5:8000/v1' } }), providerNames)).toBe('10.0.0.5:8000')
    expect(modelVendor(card({ providerId: null, providerType: null, endpointRef: null }), providerNames)).toBe('Unassigned')
    expect(whereItRuns(card({ region: 'us-east' }), providerNames)).toBe('Anthropic prod, us-east')
  })
})

describe('buildRoutingPolicy', () => {
  it('turns the picked cards into a chain under the chosen objective', () => {
    const cards = [card(), card({ id: 'c2' })]
    expect(buildRoutingPolicy(cards, 'cheapest')).toEqual({ objective: 'cheapest', fallbackChain: ['c1', 'c2'] })
    expect(buildRoutingPolicy(cards, 'pinned')).toEqual({ objective: 'pinned', fallbackChain: ['c1', 'c2'], pinnedModel: 'c1' })
    expect(buildRoutingPolicy([], 'fastest')).toEqual({ objective: 'fastest' })
  })

  it('counts the vendors a set spans, busiest first', () => {
    const cards = [card(), card({ id: 'c2' }), card({ id: 'c3', providerId: 'p2', providerType: 'moonshot' })]
    expect(vendorsOf(cards, providerNames)).toEqual([
      { vendor: 'Anthropic prod', count: 2 },
      { vendor: 'Moonshot', count: 1 },
    ])
  })
})

describe('RoutingSetBar', () => {
  it('copies the policy for the picked cards and warns about the ones the router will skip', () => {
    copy.mockClear()
    const cards = [card(), card({ id: 'c2', name: 'Kimi', providerId: 'p2', selectable: false })]
    render(
      <RoutingSetBar cards={cards} providerNames={providerNames} objective="cheapest" onObjectiveChange={() => {}} onRemove={() => {}} onClear={() => {}} />,
    )

    expect(screen.getByTestId('routing-set-bar')).toHaveTextContent('2 models across 2 vendors, run together')
    expect(screen.getByTestId('routing-set-warning')).toHaveTextContent('1 of these is not selectable yet')

    fireEvent.click(screen.getByRole('button', { name: /Copy routing policy/ }))
    expect(copy).toHaveBeenCalledWith(JSON.stringify({ objective: 'cheapest', fallbackChain: ['c1', 'c2'] }, null, 2), 'Routing policy')
  })

  it('drops a card from the set and stays out of the way when nothing is picked', () => {
    const onRemove = vi.fn()
    const { unmount } = render(
      <RoutingSetBar cards={[card()]} providerNames={providerNames} objective="pinned" onObjectiveChange={() => {}} onRemove={onRemove} onClear={() => {}} />,
    )
    expect(screen.getByText(/Always Sonnet; the rest take over when it fails/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sonnet from the routing set' }))
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
    unmount()

    render(<RoutingSetBar cards={[]} providerNames={providerNames} objective="cheapest" onObjectiveChange={() => {}} onRemove={() => {}} onClear={() => {}} />)
    expect(screen.queryByTestId('routing-set-bar')).not.toBeInTheDocument()
  })
})
