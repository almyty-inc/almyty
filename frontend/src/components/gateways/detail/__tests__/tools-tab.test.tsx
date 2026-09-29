import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { GatewayToolsTab } from '../tools-tab'

const tool = { id: 'tool-1', name: 'getForecast', description: 'Get the forecast', status: 'active', type: 'api', apiId: 'api-1', api: { id: 'api-1', name: 'E2E Forecast' } }

function renderTab(overrides: Partial<Parameters<typeof GatewayToolsTab>[0]> = {}) {
  const props = {
    gatewayTools: [],
    allTools: [tool],
    isLoadingGatewayTools: false,
    isLoadingAllTools: false,
    bulkAssignPending: false,
    assignPending: false,
    removePending: false,
    onApplyPreset: vi.fn(),
    onRequestRemoveAll: vi.fn(),
    onAssign: vi.fn(),
    onRemove: vi.fn(),
    onSaveSecurity: vi.fn(),
    hidePresets: true,
    ...overrides,
  }
  return { props, ...render(<GatewayToolsTab {...props} />) }
}

describe('GatewayToolsTab group header', () => {
  it('puts the select-all checkbox beside the expand button, never inside it', () => {
    const { container } = renderTab()
    // A button inside a button is invalid HTML: React warns, and a click on
    // the checkbox is also a click on the row.
    expect(container.querySelectorAll('button button')).toHaveLength(0)
    expect(screen.getByRole('checkbox', { name: 'Select all tools from E2E Forecast' })).toBeInTheDocument()
  })

  it('selects the group with the checkbox without expanding it, and expands with the header', async () => {
    const user = userEvent.setup()
    const { props } = renderTab()
    const header = screen.getByRole('button', { name: /E2E Forecast/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')

    await user.click(screen.getByRole('checkbox', { name: 'Select all tools from E2E Forecast' }))
    expect(props.onAssign).toHaveBeenCalledWith('tool-1')
    expect(header).toHaveAttribute('aria-expanded', 'false')

    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('getForecast')).toBeInTheDocument()
  })
})
