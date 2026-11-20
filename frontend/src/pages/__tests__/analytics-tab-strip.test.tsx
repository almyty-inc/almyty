import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../test/setup'

// The tab bodies fetch their own data; only the strip is under test here.
vi.mock('@/components/analytics/overview-tab', () => ({ OverviewTab: () => null }))
vi.mock('@/components/analytics/agents-tab', () => ({ AgentsTab: () => null }))
vi.mock('@/components/analytics/audit-tab', () => ({ AuditTab: () => null }))
vi.mock('@/components/analytics/cost-tab', () => ({ CostTab: () => null }))
vi.mock('@/components/analytics/budgets-tab', () => ({ BudgetsTab: () => null }))
vi.mock('@/components/analytics/gateways-tab', () => ({ GatewaysTab: () => null }))
vi.mock('@/components/analytics/llm-tab', () => ({ LlmTab: () => null }))
vi.mock('@/components/analytics/request-log-tab', () => ({ RequestLogTab: () => null }))
vi.mock('@/components/analytics/routing-tab', () => ({ RoutingTab: () => null }))
vi.mock('@/components/analytics/chargeback-tab', () => ({ ChargebackTab: () => null }))
vi.mock('@/components/analytics/tools-tab', () => ({ ToolsTab: () => null }))

import { AnalyticsPage } from '../analytics'

/**
 * At 1440 wide the eleven Analytics tabs wrapped "Audit trail" onto a
 * second row (measured on staging: 2 rows in a 1110px strip). With the
 * tighter trigger padding they measure 1085px, one row; on a desktop the
 * strip never wraps (it scrolls sideways if it ever has to), and a phone
 * still wraps like every other strip. jsdom has no layout, so this pins
 * the classes that make it so.
 */
describe('Analytics tab strip', () => {
  it('keeps every tab on one row on a desktop', () => {
    render(<AnalyticsPage />)

    const strip = screen.getByTestId('analytics-tabs')
    expect(strip).toHaveClass('flex-wrap', 'lg:flex-nowrap', 'lg:overflow-x-auto')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toContain('Audit trail')
    expect(tabs).toHaveLength(11)
    for (const tab of tabs) {
      expect(tab).toHaveClass('shrink-0', 'px-2.5')
      expect(tab).not.toHaveClass('px-3')
    }
  })
})
