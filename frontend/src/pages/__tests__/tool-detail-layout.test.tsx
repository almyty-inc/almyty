import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'

import { render } from '../../test/setup'
import { ToolDetailPage } from '../tool-detail'
import { toolsApi, workspacesApi } from '../../lib/api'

// The tool page laid out like the agent page: breadcrumb header, state badge
// beside the name, an actions group with a switch that says On/Off, underline
// section tabs, and a stat row that never invents a zero.

vi.mock('../../lib/api', () => ({
  toolsApi: { getById: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), execute: vi.fn(), getSkill: vi.fn() },
  workspacesApi: { getAll: vi.fn() },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))

let search = ''
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({ id: 'tool-1' }),
    useSearchParams: () => [new URLSearchParams(search), vi.fn()],
  }
})

const TOOL = { id: 'tool-1', name: 'get_v1_forecast', type: 'api', status: 'draft', parameters: {}, usageCount: 0, successRate: 0, averageResponseTime: 0 }

describe('ToolDetailPage layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    search = ''
    vi.mocked(toolsApi.getById).mockResolvedValue(TOOL as any)
    vi.mocked(workspacesApi.getAll).mockResolvedValue([] as any)
  })

  it('opens with the breadcrumb header, the state badge and the actions group', async () => {
    render(<ToolDetailPage />)
    expect(await screen.findByRole('heading', { level: 1, name: 'get_v1_forecast' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Tools')
    expect(screen.getByTestId('tool-status')).toHaveTextContent(/^Draft$/)
    const actions = screen.getByRole('group', { name: 'Tool actions' })
    expect(within(actions).getByRole('switch', { name: 'Activate tool' })).toBeInTheDocument()
    expect(actions).toHaveTextContent('Off')
  })

  it('uses underline tabs for the sections', async () => {
    render(<ToolDetailPage />)
    const tabs = await screen.findByRole('tablist', { name: 'Tool sections' })
    expect(tabs).toHaveAttribute('data-variant', 'underline')
    expect(within(tabs).getByRole('tab', { name: 'Test tool' })).toBeInTheDocument()
  })

  it('shows "--" for a rate and a time before the tool has run', async () => {
    search = 'tab=stats'
    render(<ToolDetailPage />)
    const stats = await screen.findByTestId('tool-stats')
    expect(stats).toHaveTextContent('Total runs0')
    expect(stats).toHaveTextContent('Succeeded--')
    expect(stats).toHaveTextContent('Avg response time--')
    expect(stats).not.toHaveTextContent('0%')
  })
})
