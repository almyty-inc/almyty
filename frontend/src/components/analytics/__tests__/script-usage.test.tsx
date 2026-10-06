import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../../test/setup'

/**
 * Sandbox CPU in usage (code mode, decision 14): the scripts agents ran,
 * the calls they made and the CPU they used, on the Tools tab, once there
 * are any.
 */
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
  apiGet: vi.fn(),
  analyticsApi: {
    getToolUsage: vi.fn().mockResolvedValue([]),
    getScriptUsage: vi.fn(),
  },
  toolsApi: { getAll: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))
vi.mock('@/lib/list-queries', () => ({
  toolsQuery: () => ({ queryKey: ['tools'], queryFn: async () => ({ items: [] }) }),
}))

import { analyticsApi } from '@/lib/api'
import { ToolsTab } from '../tools-tab'

describe('script usage on the Tools tab', () => {
  it('shows the scripts, their calls and the sandbox CPU', async () => {
    ;(analyticsApi.getScriptUsage as any).mockResolvedValue({ scripts: 12, failed: 1, withChanges: 3, cpuMs: 4500, calls: 140 })
    render(<ToolsTab />)
    const panel = await screen.findByTestId('script-usage')
    expect(panel).toHaveTextContent('Scripts run12')
    expect(panel).toHaveTextContent('Calls from scripts140')
    expect(panel).toHaveTextContent('Sandbox CPU4.50s')
    expect(panel).toHaveTextContent('Scripts that failed1')
  })

  it('shows nothing about scripts where none ran', async () => {
    ;(analyticsApi.getScriptUsage as any).mockResolvedValue({ scripts: 0, failed: 0, withChanges: 0, cpuMs: 0, calls: 0 })
    render(<ToolsTab />)
    await screen.findByText(/no tool usage/i).catch(() => undefined)
    expect(screen.queryByTestId('script-usage')).not.toBeInTheDocument()
  })
})
