/**
 * The amount rule's hint said "Just the number; the tool's own currency."
 * for every number, so a rule on Open-Meteo's forecast_days talked about a
 * currency. It now says something true for any number a tool takes.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '../../../test/setup'

vi.mock('../../../lib/api', () => ({ toolsApi: { getAll: vi.fn() } }))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

import { toolsApi } from '../../../lib/api'
import { AMOUNT_HINT, AmountRuleFields } from '../approval-amount-rule'

const FORECAST = {
  id: 'tool-forecast',
  name: 'open_meteo_get_v1_forecast',
  parameters: { type: 'object', properties: { latitude: { type: 'number' }, forecast_days: { type: 'integer' } } },
}

describe('the amount rule hint', () => {
  it('names no currency when the number is not money', async () => {
    vi.mocked(toolsApi.getAll).mockResolvedValue([FORECAST] as any)
    renderWithProviders(
      <AmountRuleFields value={{ toolId: 'tool-forecast', argument: 'forecast_days', op: 'gt', amount: '7' }} onChange={vi.fn()} />,
    )

    expect(await screen.findByText(AMOUNT_HINT)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/currency/i)
  })
})
